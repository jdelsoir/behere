/**
 * BeHERE minimal GTFS-realtime decoder.
 *
 * A hand-written protobuf *wire format* reader plus exactly the GTFS-RT field
 * numbers this app reads. No library, no CDN, no build step, no .proto file and
 * no code generation: the wire format is self-describing enough that a decoder
 * which knows the field numbers it wants can skip everything else.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The NAP endpoint content-negotiates, and the default is *not* protobuf:
 *
 *     .../rt/trip-update                     -> application/json      (default)
 *     .../rt/trip-update?format=json         -> application/json
 *     .../rt/trip-update?format=protobuf     -> application/protobuf
 *     .../rt/trip-update?format=pb           -> 400
 *       {"error":{"type":"INVALID_PARAMETER","parameter":"format",
 *                 "acceptedValues":["json","protobuf"]}}
 *
 * So JSON is available and this decoder is not strictly required. It is used
 * anyway because protobuf is 2.2x to 3.2x smaller on the wire, measured live
 * on 15 August 2026 (bytes, not estimates):
 *
 *     operator  feed              json        protobuf    ratio
 *     delijn    trip-update       4,420,220   1,622,658   2.72x
 *     delijn    alert                29,799      17,566   1.70x
 *     tec       trip-update       1,543,277     487,822   3.16x
 *     tec       alert             1,065,075     539,580   1.97x
 *     tec       vehicle-position    179,693      60,896   2.95x
 *     nmbssncb  trip-update         189,397      72,209   2.62x
 *     nmbssncb  alert               100,309      86,365   1.16x
 *
 * De Lijn trip-update is the one that matters: 4.4 MB of JSON on a phone, or
 * 1.6 MB of protobuf. Both are too big to parse eagerly into objects, which is
 * what `decodeTripUpdates` is built around (see LAZINESS below).
 *
 * THIS DECODER IS NOT FASTER THAN `JSON.parse`, AND NOTHING HERE CLAIMS IT IS.
 * Measured on the De Lijn feed: walking 1,549 trip updates for 12 on-screen
 * stops took 37.8 ms, while `JSON.parse` of the equivalent 4.3 MB JSON took
 * 8.6 ms. V8's parser is native C++ and this is hand-written JS. The win is
 * the two things that actually hurt on a phone:
 *   - bytes over the network: 1.56 MB instead of 4.28 MB, every 30 s
 *   - allocation: 40 row objects instead of a 4.3 MB object graph and the
 *     garbage collection that follows it
 * Anyone tempted to "optimise" by switching to `?format=json` should weigh
 * those two, not the parse microbenchmark.
 *
 * Feeds that do not exist (verified, all four operators x three feed types):
 *     stibmivb  trip-update / alert / vehicle-position  -> 404
 *     delijn    vehicle-position                        -> 404
 *     nmbssncb  vehicle-position                        -> 404
 * TEC is the only operator publishing vehicle positions, as PLAN says.
 *
 * LAZINESS
 * --------
 * Protobuf has no index, so the whole buffer must be *walked*. What must not
 * happen is materialising it. `decodeTripUpdates` takes the set of stop_ids
 * actually on screen (at most a couple of dozen), pre-encodes them to UTF-8
 * bytes once, and compares stop_id byte-for-byte inside the buffer. A
 * TextDecoder call, a JS string and an object literal only ever happen for a
 * stop the user can see. On the De Lijn feed that is ~30,000 trip updates
 * walked and a handful allocated.
 *
 * SIGNED INTEGERS
 * ---------------
 * StopTimeEvent.delay is proto `int32`, NOT `sint32`. A negative int32 is
 * sign-extended to 64 bits and ships as a TEN byte varint, so
 * `0xC4 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF 0x01` is -60, not a huge
 * positive number. Reading it as an unsigned JS number gives 1.8e19 and a
 * train "delayed" by 584 billion years. This decoder keeps the varint as two
 * 32-bit halves and reads `lo | 0`, which is exactly two's complement int32.
 * `zigzag32/64` are provided for completeness (proto sint32/sint64); GTFS-RT
 * does not use them, and that is asserted rather than assumed.
 *
 * Numbers above 2^53 cannot be represented exactly by a JS number. Timestamps
 * (~1.79e9) are nowhere near that, so `asNumber` is safe for every field here.
 *
 * @module gtfsrt
 */

// ---------------------------------------------------------------- wire types

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_SGROUP = 3; // deprecated in proto3, still skippable
const WIRE_EGROUP = 4;
const WIRE_I32 = 5;

const TEXT = new TextDecoder("utf-8");
const BYTES = new TextEncoder();

/**
 * A cursor over a protobuf buffer.
 *
 * Every read advances `pos`. Nothing is copied: `sub()` returns a Reader over
 * the same underlying ArrayBuffer, so nesting is free.
 */
export class Reader {
  /**
   * @param {Uint8Array} buf
   * @param {number} [start]
   * @param {number} [end]
   */
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get eof() {
    return this.pos >= this.end;
  }

  /**
   * Read a base-128 varint as two unsigned 32-bit halves.
   *
   * Returned as a pair rather than a number so the caller can choose the
   * interpretation (uint64 / int32 / zigzag) without losing the sign bits.
   * @returns {{lo: number, hi: number}}
   */
  varint() {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    let b = 0;
    // low 32 bits: bytes 0..3 plus 4 bits of byte 4
    while (shift < 28) {
      if (this.pos >= this.end) throw new RangeError("varint past end");
      b = this.buf[this.pos++];
      lo |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { lo: lo >>> 0, hi: 0 };
      shift += 7;
    }
    if (this.pos >= this.end) throw new RangeError("varint past end");
    b = this.buf[this.pos++];
    lo |= (b & 0x0f) << 28;
    hi = (b & 0x7f) >>> 4;
    if ((b & 0x80) === 0) return { lo: lo >>> 0, hi: hi >>> 0 };
    // high bits: byte 4 contributed 3, then bytes 5..9
    shift = 3;
    while (shift < 32) {
      if (this.pos >= this.end) throw new RangeError("varint past end");
      b = this.buf[this.pos++];
      hi |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { lo: lo >>> 0, hi: hi >>> 0 };
      shift += 7;
    }
    throw new RangeError("varint longer than 10 bytes");
  }

  /** Varint as an unsigned JS number. Exact below 2^53. */
  uint() {
    const v = this.varint();
    return v.hi * 4294967296 + v.lo;
  }

  /** Varint as a proto int32 / int64-truncated-to-32. Handles negatives. */
  int32() {
    return this.varint().lo | 0;
  }

  /** Varint as a proto bool. */
  bool() {
    const v = this.varint();
    return (v.lo | v.hi) !== 0;
  }

  /** Varint as a proto sint32 (zigzag). Unused by GTFS-RT; kept for the format. */
  sint32() {
    const lo = this.varint().lo;
    return (lo >>> 1) ^ -(lo & 1);
  }

  /** Varint as a proto sint64 (zigzag), as a JS number. */
  sint64() {
    const { lo, hi } = this.varint();
    const n = hi * 4294967296 + lo;
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  /** 32-bit little-endian float (proto `float`). */
  float() {
    const p = this.pos;
    this.pos += 4;
    const b = this.buf;
    return new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, true);
  }

  /** 64-bit little-endian double (proto `double`). */
  double() {
    const p = this.pos;
    this.pos += 8;
    const b = this.buf;
    return new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, true);
  }

  /** A length-delimited field's byte range, without copying. */
  lenRange() {
    const n = this.uint();
    const start = this.pos;
    const stop = start + n;
    if (stop > this.end) throw new RangeError("length-delimited past end");
    this.pos = stop;
    return { start, end: stop };
  }

  /** A length-delimited field as a Reader over the same buffer. */
  sub() {
    const r = this.lenRange();
    return new Reader(this.buf, r.start, r.end);
  }

  /** A length-delimited field as a UTF-8 string. Allocates: use sparingly. */
  string() {
    const r = this.lenRange();
    return TEXT.decode(this.buf.subarray(r.start, r.end));
  }

  /**
   * Read a tag.
   * @returns {{field: number, wire: number}}
   */
  tag() {
    const t = this.uint();
    return { field: t >>> 3, wire: t & 7 };
  }

  /** Skip the value that follows a tag of the given wire type. */
  skip(wire) {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_I64:
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.lenRange();
        return;
      case WIRE_I32:
        this.pos += 4;
        return;
      case WIRE_SGROUP: {
        // Skip to the matching end-group.
        for (;;) {
          const t = this.tag();
          if (t.wire === WIRE_EGROUP) return;
          this.skip(t.wire);
        }
      }
      case WIRE_EGROUP:
        return;
      default:
        throw new RangeError("unknown wire type " + wire);
    }
  }

  /**
   * Iterate every (field, wire) tag in this reader's range, calling `fn`.
   * `fn` must consume or skip the value; anything it leaves is skipped for it.
   * @param {(field: number, wire: number, r: Reader) => void} fn
   */
  each(fn) {
    while (!this.eof) {
      const { field, wire } = this.tag();
      const before = this.pos;
      fn(field, wire, this);
      if (this.pos === before) this.skip(wire);
    }
  }
}

// -------------------------------------------------- GTFS-realtime field map
//
// From the canonical gtfs-realtime.proto. These numbers are the wire contract;
// every one below was confirmed against real NAP bytes (see verify_gtfsrt.mjs).

/** @enum {number} */
export const F = {
  // FeedMessage
  FEED_HEADER: 1,
  FEED_ENTITY: 2,
  // FeedHeader
  HDR_VERSION: 1,
  HDR_INCREMENTALITY: 2,
  HDR_TIMESTAMP: 3,
  // FeedEntity
  ENT_ID: 1,
  ENT_IS_DELETED: 2,
  ENT_TRIP_UPDATE: 3,
  ENT_VEHICLE: 4,
  ENT_ALERT: 5,
  // TripUpdate
  TU_TRIP: 1,
  TU_STOP_TIME_UPDATE: 2,
  TU_VEHICLE: 3,
  TU_TIMESTAMP: 4,
  TU_DELAY: 5,
  // TripDescriptor
  TD_TRIP_ID: 1,
  TD_START_TIME: 2,
  TD_START_DATE: 3,
  TD_SCHEDULE_REL: 4,
  TD_ROUTE_ID: 5,
  TD_DIRECTION_ID: 6,
  // StopTimeUpdate
  STU_STOP_SEQUENCE: 1,
  STU_ARRIVAL: 2,
  STU_DEPARTURE: 3,
  STU_STOP_ID: 4,
  STU_SCHEDULE_REL: 5,
  // StopTimeEvent
  STE_DELAY: 1,
  STE_TIME: 2,
  STE_UNCERTAINTY: 3,
  // VehiclePosition
  VP_TRIP: 1,
  VP_POSITION: 2,
  VP_CURRENT_STOP_SEQUENCE: 3,
  VP_CURRENT_STATUS: 4,
  VP_TIMESTAMP: 5,
  VP_STOP_ID: 7,
  VP_VEHICLE: 8,
  // Position
  POS_LAT: 1,
  POS_LON: 2,
  POS_BEARING: 3,
  POS_ODOMETER: 4,
  POS_SPEED: 5,
  // VehicleDescriptor
  VD_ID: 1,
  VD_LABEL: 2,
  // Alert
  AL_ACTIVE_PERIOD: 1,
  AL_INFORMED_ENTITY: 5,
  AL_CAUSE: 6,
  AL_EFFECT: 7,
  AL_URL: 8,
  AL_HEADER_TEXT: 10,
  AL_DESCRIPTION_TEXT: 11,
  // TimeRange
  TR_START: 1,
  TR_END: 2,
  // EntitySelector
  ES_AGENCY_ID: 1,
  ES_ROUTE_ID: 2,
  ES_ROUTE_TYPE: 3,
  ES_TRIP: 4,
  ES_STOP_ID: 5,
  // TranslatedString / Translation
  TS_TRANSLATION: 1,
  TL_TEXT: 1,
  TL_LANGUAGE: 2,
};

/** GTFS-RT ScheduleRelationship on a StopTimeUpdate. */
export const STU_SCHEDULED = 0;
export const STU_SKIPPED = 1;
export const STU_NO_DATA = 2;

/** GTFS-RT Alert.effect, the subset worth naming. */
export const EFFECT = {
  1: "no-service",
  2: "reduced-service",
  3: "significant-delays",
  4: "detour",
  5: "additional-service",
  6: "modified-service",
  7: "other-effect",
  8: "unknown-effect",
  9: "stop-moved",
  10: "no-effect",
  11: "accessibility-issue",
};

// ------------------------------------------------------------------ helpers

/** Compare a byte range in `buf` to a pre-encoded needle. */
function bytesEqual(buf, start, end, needle) {
  if (end - start !== needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (buf[start + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * Read the feed header without walking the entities.
 *
 * The header is field 1 and the producers emit it first, so this returns as
 * soon as it has been read. On a 1.6 MB De Lijn feed this touches ~15 bytes.
 *
 * NOTE ON `incrementality`. Measured on the live feeds: De Lijn and NMBS-SNCB
 * send 0 (FULL_DATASET), TEC sends 1 (DIFFERENTIAL). DIFFERENTIAL is declared
 * but left unspecified by the GTFS-realtime specification, and TEC's payload
 * is in fact a complete snapshot each time (15,666 stop_time_updates over
 * 9,257 stops, cross-checked against the operator's own JSON rendering of the
 * same generation). Every feed is therefore treated as a full snapshot, which
 * is what every consumer does. Recorded here so the choice is deliberate.
 *
 * @param {Uint8Array} bytes
 * @returns {{version: string, incrementality: number, timestamp: number}}
 */
export function decodeHeader(bytes) {
  const r = new Reader(bytes);
  const out = { version: "", incrementality: 0, timestamp: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === F.FEED_HEADER && wire === WIRE_LEN) {
      const h = r.sub();
      h.each((f, w, rr) => {
        if (f === F.HDR_VERSION && w === WIRE_LEN) out.version = rr.string();
        else if (f === F.HDR_INCREMENTALITY && w === WIRE_VARINT) out.incrementality = rr.uint();
        else if (f === F.HDR_TIMESTAMP && w === WIRE_VARINT) out.timestamp = rr.uint();
      });
      return out;
    }
    r.skip(wire);
  }
  return out;
}

/**
 * Extract predicted departures for a specific set of stops.
 *
 * This is the hot path. It walks the whole buffer (protobuf is not indexed)
 * but allocates only for matching stops. See LAZINESS at the top of the file.
 *
 * @param {Uint8Array} bytes            Raw protobuf.
 * @param {Iterable<string>} stopIds    stop_ids currently on screen.
 * @returns {{
 *   timestamp: number,
 *   scanned: number,
 *   matched: number,
 *   byStop: Map<string, Array<{
 *     tripId: string, routeId: string, startDate: string, startTime: string,
 *     stopSequence: number, delay: number|null, time: number|null,
 *     tripDelay: number|null, skipped: boolean, noData: boolean
 *   }>>
 * }}
 */
export function decodeTripUpdates(bytes, stopIds) {
  const needles = [];
  for (const id of stopIds) {
    if (typeof id === "string" && id.length) needles.push({ id, b: BYTES.encode(id) });
  }
  /** @type {Map<string, any[]>} */
  const byStop = new Map();
  const result = { timestamp: 0, scanned: 0, matched: 0, byStop };
  if (!needles.length) return result;

  const r = new Reader(bytes);
  while (!r.eof) {
    const { field, wire } = r.tag();

    if (field === F.FEED_HEADER && wire === WIRE_LEN) {
      const h = r.sub();
      h.each((f, w, rr) => {
        if (f === F.HDR_TIMESTAMP && w === WIRE_VARINT) result.timestamp = rr.uint();
      });
      continue;
    }

    if (field !== F.FEED_ENTITY || wire !== WIRE_LEN) {
      r.skip(wire);
      continue;
    }

    const ent = r.sub();
    while (!ent.eof) {
      const t = ent.tag();
      if (t.field !== F.ENT_TRIP_UPDATE || t.wire !== WIRE_LEN) {
        ent.skip(t.wire);
        continue;
      }
      result.scanned++;
      const tu = ent.sub();

      // Pass 1 over the TripUpdate: note where the trip descriptor is and
      // collect the stop_time_updates that match, without decoding strings.
      let tripRange = null;
      let tuDelay = null;
      /** @type {Array<{needle: string, range: {start: number, end: number}}>} */
      const hits = [];

      while (!tu.eof) {
        const ft = tu.tag();
        if (ft.field === F.TU_TRIP && ft.wire === WIRE_LEN) {
          tripRange = tu.lenRange();
        } else if (ft.field === F.TU_DELAY && ft.wire === WIRE_VARINT) {
          tuDelay = tu.int32();
        } else if (ft.field === F.TU_STOP_TIME_UPDATE && ft.wire === WIRE_LEN) {
          const range = tu.lenRange();
          // Cheap scan for stop_id (field 4) only.
          const stu = new Reader(bytes, range.start, range.end);
          let hit = null;
          while (!stu.eof) {
            const fs = stu.tag();
            if (fs.field === F.STU_STOP_ID && fs.wire === WIRE_LEN) {
              const sr = stu.lenRange();
              for (const n of needles) {
                if (bytesEqual(bytes, sr.start, sr.end, n.b)) {
                  hit = n.id;
                  break;
                }
              }
              break; // stop_id seen; no need to read the rest yet
            }
            stu.skip(fs.wire);
          }
          if (hit) hits.push({ needle: hit, range });
        } else {
          tu.skip(ft.wire);
        }
      }

      if (!hits.length) continue;

      // Only now does anything get allocated.
      let tripId = "";
      let routeId = "";
      let startDate = "";
      let startTime = "";
      if (tripRange) {
        const td = new Reader(bytes, tripRange.start, tripRange.end);
        td.each((f, w, rr) => {
          if (f === F.TD_TRIP_ID && w === WIRE_LEN) tripId = rr.string();
          else if (f === F.TD_ROUTE_ID && w === WIRE_LEN) routeId = rr.string();
          else if (f === F.TD_START_DATE && w === WIRE_LEN) startDate = rr.string();
          else if (f === F.TD_START_TIME && w === WIRE_LEN) startTime = rr.string();
        });
      }

      for (const h of hits) {
        const stu = new Reader(bytes, h.range.start, h.range.end);
        let stopSequence = -1;
        let rel = STU_SCHEDULED;
        // Arrival and departure are kept apart and merged afterwards. Mixing
        // them inside the loop makes the precedence depend on field order,
        // which is not guaranteed by protobuf.
        let arrDelay = null;
        let arrTime = null;
        let depDelay = null;
        let depTime = null;

        stu.each((f, w, rr) => {
          if (f === F.STU_STOP_SEQUENCE && w === WIRE_VARINT) stopSequence = rr.uint();
          else if (f === F.STU_SCHEDULE_REL && w === WIRE_VARINT) rel = rr.uint();
          else if ((f === F.STU_DEPARTURE || f === F.STU_ARRIVAL) && w === WIRE_LEN) {
            const isDep = f === F.STU_DEPARTURE;
            const ev = rr.sub();
            let d = null;
            let tm = null;
            ev.each((f2, w2, r2) => {
              if (f2 === F.STE_DELAY && w2 === WIRE_VARINT) d = r2.int32();
              else if (f2 === F.STE_TIME && w2 === WIRE_VARINT) tm = r2.uint();
            });
            if (isDep) {
              depDelay = d;
              depTime = tm;
            } else {
              arrDelay = d;
              arrTime = tm;
            }
          }
        });

        // A departure prediction beats an arrival one; absent stays absent.
        //
        // TripUpdate.delay (field 5) is deliberately NOT used as a per-stop
        // fallback. TEC sets a trip-level delay AND marks stops NO_DATA, and
        // treating the trip delay as a stop prediction produced 1,753 phantom
        // "negative delays" against the server's 629 on a live feed. NO_DATA
        // means exactly what it says: no prediction exists for this stop.
        const delay = depDelay !== null ? depDelay : arrDelay;
        const time = depTime !== null ? depTime : arrTime;

        result.matched++;
        const row = {
          tripId,
          routeId,
          startDate,
          startTime,
          stopSequence,
          delay,
          time,
          /** Trip-level delay, a weaker hint. Never a substitute for the above. */
          tripDelay: tuDelay,
          skipped: rel === STU_SKIPPED,
          noData: rel === STU_NO_DATA,
        };
        const arr = byStop.get(h.needle);
        if (arr) arr.push(row);
        else byStop.set(h.needle, [row]);
      }
    }
  }
  return result;
}

/**
 * Extract service alerts touching a set of stops or routes.
 *
 * THE SELECTOR SHAPES ARE NOT UNIFORM. Measured across the three operators
 * that publish alerts (15 August 2026):
 *
 *   NMBS-SNCB  36 alerts   informed_entity = {agency_id} ONLY. No stop, no
 *                          route, ever. Every one is agency-wide.
 *   TEC        722 alerts  {agency_id, direction_id, route_id, route_type,
 *                          stop_id} but route_id is null and stop_id is ""
 *                          on the ones sampled: present-but-empty.
 *   De Lijn    9 alerts    {agency_id, route_id, stop_id} with real values
 *                          ("gs:delijn:201101"): genuinely stop-specific.
 *
 * So filtering on stop_id alone drops all 36 NMBS alerts, which is how this
 * function was first written and what the verification run caught. The rule
 * that matches reality: an EntitySelector with no usable stop_id and no
 * usable route_id is AGENCY-WIDE and applies to every stop of that operator.
 * Empty string and absent are the same thing.
 *
 * Alerts are also the richest authored-English source in the whole app:
 * NMBS ships fr/nl/de/en on all 36, De Lijn on all 9, TEC on 20 of 722.
 * These are operator-authored, so using them does not breach the
 * no-machine-translation rule.
 *
 * @param {Uint8Array} bytes
 * @param {Iterable<string>} stopIds
 * @param {Iterable<string>} [routeIds]
 * @returns {{timestamp: number, scanned: number, alerts: Array<{
 *   id: string, effect: string, cause: number,
 *   header: Object<string,string>, description: Object<string,string>,
 *   url: Object<string,string>,
 *   stops: string[], routes: string[], agencyWide: boolean,
 *   start: number|null, end: number|null
 * }>}}
 */
export function decodeAlerts(bytes, stopIds, routeIds = []) {
  const wantStops = new Set(stopIds);
  const wantRoutes = new Set(routeIds);
  const r = new Reader(bytes);
  const out = { timestamp: 0, scanned: 0, alerts: [] };

  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === F.FEED_HEADER && wire === WIRE_LEN) {
      const h = r.sub();
      h.each((f, w, rr) => {
        if (f === F.HDR_TIMESTAMP && w === WIRE_VARINT) out.timestamp = rr.uint();
      });
      continue;
    }
    if (field !== F.FEED_ENTITY || wire !== WIRE_LEN) {
      r.skip(wire);
      continue;
    }
    const ent = r.sub();
    let id = "";
    let alertRange = null;
    ent.each((f, w, rr) => {
      if (f === F.ENT_ID && w === WIRE_LEN) id = rr.string();
      else if (f === F.ENT_ALERT && w === WIRE_LEN) alertRange = rr.lenRange();
    });
    if (!alertRange) continue;
    out.scanned++;

    const al = new Reader(bytes, alertRange.start, alertRange.end);
    const stops = [];
    const routes = [];
    let agencyWide = false;
    let effect = 8;
    let cause = 1;
    let start = null;
    let end = null;
    let header = null;
    let description = null;
    let url = null;

    al.each((f, w, rr) => {
      if (f === F.AL_INFORMED_ENTITY && w === WIRE_LEN) {
        const es = rr.sub();
        let s = "";
        let ro = "";
        es.each((f2, w2, r2) => {
          if (f2 === F.ES_STOP_ID && w2 === WIRE_LEN) s = r2.string();
          else if (f2 === F.ES_ROUTE_ID && w2 === WIRE_LEN) ro = r2.string();
        });
        if (s) stops.push(s);
        if (ro) routes.push(ro);
        // No usable stop and no usable route: this selector covers the agency.
        if (!s && !ro) agencyWide = true;
      } else if (f === F.AL_ACTIVE_PERIOD && w === WIRE_LEN) {
        const tr = rr.sub();
        tr.each((f2, w2, r2) => {
          if (f2 === F.TR_START && w2 === WIRE_VARINT) start = r2.uint();
          else if (f2 === F.TR_END && w2 === WIRE_VARINT) end = r2.uint();
        });
      } else if (f === F.AL_EFFECT && w === WIRE_VARINT) effect = rr.uint();
      else if (f === F.AL_CAUSE && w === WIRE_VARINT) cause = rr.uint();
      else if (f === F.AL_HEADER_TEXT && w === WIRE_LEN) header = readTranslated(rr.sub());
      else if (f === F.AL_DESCRIPTION_TEXT && w === WIRE_LEN) description = readTranslated(rr.sub());
      else if (f === F.AL_URL && w === WIRE_LEN) url = readTranslated(rr.sub());
    });

    const touchesStop = stops.some((s) => wantStops.has(s));
    const touchesRoute = routes.some((s) => wantRoutes.has(s));
    if (!agencyWide && !touchesStop && !touchesRoute) continue;

    out.alerts.push({
      id,
      effect: EFFECT[effect] || "unknown-effect",
      cause,
      header: header || {},
      description: description || {},
      url: url || {},
      stops,
      routes,
      agencyWide,
      start,
      end,
    });
  }
  return out;
}

/**
 * A GTFS-RT TranslatedString to `{lang: text}`.
 * Untagged translations (no `language`) land under `""`.
 * @param {Reader} r
 */
export function readTranslated(r) {
  /** @type {Object<string,string>} */
  const out = {};
  r.each((f, w, rr) => {
    if (f !== F.TS_TRANSLATION || w !== WIRE_LEN) return;
    const tl = rr.sub();
    let text = "";
    let lang = "";
    tl.each((f2, w2, r2) => {
      if (f2 === F.TL_TEXT && w2 === WIRE_LEN) text = r2.string();
      else if (f2 === F.TL_LANGUAGE && w2 === WIRE_LEN) lang = r2.string();
    });
    if (text) out[lang.toLowerCase()] = text;
  });
  return out;
}

/**
 * Vehicle positions. TEC is the only operator that publishes these.
 *
 * @param {Uint8Array} bytes
 * @param {Iterable<string>} [routeIds] Optional filter; empty means all.
 * @returns {{timestamp: number, vehicles: Array<{
 *   id: string, tripId: string, routeId: string,
 *   lat: number, lon: number, bearing: number|null, speed: number|null,
 *   stopId: string, stopSequence: number, status: number, ts: number
 * }>}}
 */
export function decodeVehiclePositions(bytes, routeIds = []) {
  const want = new Set(routeIds);
  const filter = want.size > 0;
  const r = new Reader(bytes);
  const out = { timestamp: 0, vehicles: [] };

  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === F.FEED_HEADER && wire === WIRE_LEN) {
      const h = r.sub();
      h.each((f, w, rr) => {
        if (f === F.HDR_TIMESTAMP && w === WIRE_VARINT) out.timestamp = rr.uint();
      });
      continue;
    }
    if (field !== F.FEED_ENTITY || wire !== WIRE_LEN) {
      r.skip(wire);
      continue;
    }
    const ent = r.sub();
    while (!ent.eof) {
      const t = ent.tag();
      if (t.field !== F.ENT_VEHICLE || t.wire !== WIRE_LEN) {
        ent.skip(t.wire);
        continue;
      }
      const vp = ent.sub();
      let tripId = "";
      let routeId = "";
      let lat = NaN;
      let lon = NaN;
      let bearing = null;
      let speed = null;
      let stopId = "";
      let stopSequence = -1;
      let status = -1;
      let ts = 0;
      let vid = "";
      vp.each((f, w, rr) => {
        if (f === F.VP_TRIP && w === WIRE_LEN) {
          const td = rr.sub();
          td.each((f2, w2, r2) => {
            if (f2 === F.TD_TRIP_ID && w2 === WIRE_LEN) tripId = r2.string();
            else if (f2 === F.TD_ROUTE_ID && w2 === WIRE_LEN) routeId = r2.string();
          });
        } else if (f === F.VP_POSITION && w === WIRE_LEN) {
          const p = rr.sub();
          p.each((f2, w2, r2) => {
            if (f2 === F.POS_LAT && w2 === WIRE_I32) lat = r2.float();
            else if (f2 === F.POS_LON && w2 === WIRE_I32) lon = r2.float();
            else if (f2 === F.POS_BEARING && w2 === WIRE_I32) bearing = r2.float();
            else if (f2 === F.POS_SPEED && w2 === WIRE_I32) speed = r2.float();
          });
        } else if (f === F.VP_STOP_ID && w === WIRE_LEN) stopId = rr.string();
        else if (f === F.VP_CURRENT_STOP_SEQUENCE && w === WIRE_VARINT) stopSequence = rr.uint();
        else if (f === F.VP_CURRENT_STATUS && w === WIRE_VARINT) status = rr.uint();
        else if (f === F.VP_TIMESTAMP && w === WIRE_VARINT) ts = rr.uint();
        else if (f === F.VP_VEHICLE && w === WIRE_LEN) {
          const vd = rr.sub();
          vd.each((f2, w2, r2) => {
            if (f2 === F.VD_ID && w2 === WIRE_LEN) vid = r2.string();
          });
        }
      });
      if (filter && !want.has(routeId)) continue;
      out.vehicles.push({
        id: vid,
        tripId,
        routeId,
        lat,
        lon,
        bearing,
        speed,
        stopId,
        stopSequence,
        status,
        ts,
      });
    }
  }
  return out;
}
