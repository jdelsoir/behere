"""Build web/data/municipalities.json and web/data/nis_history.json.

Standard library only. Deterministic: identical inputs produce byte-identical
output, so a scheduled rebuild yields a clean diff or no diff at all.

Inputs (both official Statbel, both pinned to the 2025 vintage)
--------------------------------------------------------------
1. sh_statbel_statistical_sectors_31370_20250101.geojson
   The statistical sector geometry. Every one of its 20,781 features carries the
   full administrative hierarchy of the sector it draws: cd_munty_refnis,
   tx_munty_descr_nl/fr/de, cd_dstr_refnis, cd_prov_refnis, cd_rgn_refnis and
   their trilingual labels, plus dt_situation. Aggregating it by
   cd_munty_refnis yields the municipality reference list of the exact vintage
   the app's polygons are drawn from, which is the only vintage that matters.

2. TU_COM_REFNIS-20250101.txt
   Statbel's REFNIS code list, CP1252, pipe-delimited. Unlike the geometry it is
   a *historical* register: 2,720 municipality rows going back to 1970, each
   with DT_VLDT_START and DT_VLDT_END. That is what makes the merger history
   derivable rather than guessable.

Why two sources for one answer
------------------------------
The merger mappings are not typed in by hand and are not taken from any
secondary source. They are derived independently from each input and then
required to agree:

  * The geometry knows WHICH old code became WHICH new code. A statistical
    sector code is nine characters whose first five are the NIS of the
    municipality that existed when the sector was drawn. When a municipality
    merges, its sectors keep their old prefix but are re-attached to the new
    cd_munty_refnis. Every prefix that disagrees with its feature's
    cd_munty_refnis is therefore a merger edge, read straight off the polygons.

  * The code list knows WHEN, and knows the complete set of codes that died.
    Every row whose DT_VLDT_END is not 31/12/9999 is a retired code.

The script asserts that the set of merger edges found in the geometry is exactly
the set of codes the register says were retired in the 2019 and 2025 waves. If
Statbel ever publishes a vintage where those two disagree, this build fails
loudly rather than shipping a half-correct join table.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WEB_DATA = os.path.join(REPO, "web", "data")

VINTAGE = "2025-01-01"

SECTORS_GEOJSON = (
    "sh_statbel_statistical_sectors_31370_20250101.geojson"
)
REFNIS_TXT = "TU_COM_REFNIS-20250101.txt"

SOURCES = {
    "statbel_sectors_2025": {
        "title": "Statistical sectors of Belgium, situation 01/01/2025",
        "file": SECTORS_GEOJSON,
        "url": (
            "https://statbel.fgov.be/sites/default/files/files/opendata/"
            "Statistische%20sectoren/"
            "sh_statbel_statistical_sectors_31370_20250101.geojson.zip"
        ),
        "publisher": "Statbel (Statistics Belgium)",
        "vintage": VINTAGE,
        "role": (
            "Municipality names and hierarchy. For nis_history: the old-to-new "
            "mapping, read from statistical sector codes whose five-digit "
            "prefix is the pre-merger NIS while the feature's cd_munty_refnis "
            "is the post-merger NIS."
        ),
    },
    "statbel_refnis_2025": {
        "title": "REFNIS code list, valid from 01/01/2025",
        "file": REFNIS_TXT,
        "url": (
            "https://statbel.fgov.be/sites/default/files/files/opendata/"
            "REFNIS%20code/TU_COM_REFNIS-20250101.zip"
        ),
        "publisher": "Statbel (Statistics Belgium)",
        "vintage": VINTAGE,
        "role": (
            "Independent confirmation of the 565-code current set, and the "
            "authority for the dates: DT_VLDT_START and DT_VLDT_END give the "
            "exact day each code was retired or created."
        ),
    },
    "walloon_decree_hainaut_arrondissements_2018": {
        "title": (
            "Arrêté du Gouvernement wallon du 25 janvier 2018 modifiant les "
            "limites de certains arrondissements administratifs du Hainaut, "
            "en vigueur au 1 janvier 2019"
        ),
        "publisher": "Gouvernement wallon",
        "role": (
            "Explains the 11 records of kind \"recode\". No municipality "
            "changed; the arrondissements of Ath, Charleroi, Soignies, Thuin, "
            "Tournai and Mouscron were redrawn, the arrondissements of La "
            "Louvière and Tournai-Mouscron were created, and because the "
            "second digit of a NIS code is the arrondissement number, every "
            "affected municipality was renumbered."
        ),
    },
    "statbel_refnis_nuts_note_2025": {
        "title": (
            "REFNIS- en NUTS-nomenclaturen: wijzigingen van kracht vanaf "
            "2 december 2024 en vanaf 1 januari 2025"
        ),
        "url": (
            "https://statbel.fgov.be/sites/default/files/files/opendata/Nuts/"
            "Note%20REFNIS-NUTS%202025-NL.pdf"
        ),
        "publisher": "Statbel (Statistics Belgium)",
        "role": (
            "Narrative confirmation of the totals: states that the changes "
            "affect 30 municipalities and that the mergers took Belgium from "
            "581 to 565 municipalities."
        ),
    },
}

# The day each retired code stopped being valid, mapped to the day its successor
# took over. Bastogne and Bertogne merged a month early, on 1 December 2024;
# every other 2025-wave merger took effect on 1 January 2025.
END_TO_VALID_FROM = {
    "31/12/2018": "2019-01-01",
    "30/11/2024": "2024-12-01",
    "31/12/2024": "2025-01-01",
}


def read_refnis(path):
    """Parse TU_COM_REFNIS. Returns the list of row dicts.

    The file is CP1252, not Latin-1: apostrophes in names such as
    Braine-l'Alleud and Fontaine-l'Eveque are byte 0x92, which Latin-1 decodes
    to an unprintable control character and silently corrupts.
    """
    rows = []
    with open(path, encoding="cp1252", newline="") as fh:
        hdr = fh.readline().rstrip("\r\n").split("|")
        for line in fh:
            line = line.rstrip("\r\n")
            if line:
                rows.append(dict(zip(hdr, line.split("|"))))
    return rows


def read_sector_properties(path):
    """Stream the sector GeoJSON, yielding only the feature property dicts.

    The file is 202 MB and json.load would need well over a gigabyte of heap.
    Statbel writes one feature per line and the properties object contains only
    scalars, so the first closing brace after `"properties": {` ends it. That
    lets us slice out a few hundred bytes per line and parse those, never
    touching the megabytes of coordinates.
    """
    key = '"properties": '
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            i = line.find(key)
            if i < 0:
                continue
            start = line.index("{", i)
            end = line.index("}", start)
            props = json.loads(line[start:end + 1])
            # The FeatureCollection's own crs member also matches the marker.
            if "cd_sector" in props:
                yield props


def labels(props, prefix):
    return {
        "de": props[prefix + "_de"],
        "fr": props[prefix + "_fr"],
        "nl": props[prefix + "_nl"],
    }


def build(sectors_path, refnis_path):
    municipalities = {}
    regions = {}
    provinces = {}
    districts = {}
    merger_edges = {}       # old NIS -> new NIS
    sector_count = 0
    situations = set()

    for p in read_sector_properties(sectors_path):
        sector_count += 1
        situations.add(p["dt_situation"])
        nis = p["cd_munty_refnis"]

        rgn = p["cd_rgn_refnis"]
        regions.setdefault(rgn, labels(p, "tx_rgn_descr"))
        dstr = p["cd_dstr_refnis"]
        districts.setdefault(dstr, labels(p, "tx_adm_dstr_descr"))
        prov = p["cd_prov_refnis"]
        # The Brussels-Capital Region is not part of any province. Statbel
        # leaves cd_prov_refnis null there, and so do we: an invented province
        # would be a lie that joins would then propagate.
        if prov is not None:
            provinces.setdefault(prov, labels(p, "tx_prov_descr"))

        rec = labels(p, "tx_munty_descr")
        rec["dstr"] = dstr
        rec["prov"] = prov
        rec["rgn"] = rgn
        if nis in municipalities and municipalities[nis] != rec:
            raise SystemExit(
                "inconsistent hierarchy for NIS %s: %r vs %r"
                % (nis, municipalities[nis], rec)
            )
        municipalities[nis] = rec

        old = p["cd_sector"][:5]
        if old != nis:
            if merger_edges.get(old, nis) != nis:
                raise SystemExit(
                    "sector prefix %s maps to both %s and %s"
                    % (old, merger_edges[old], nis)
                )
            merger_edges[old] = nis

    if len(situations) != 1:
        raise SystemExit("mixed dt_situation in geometry: %r" % (situations,))
    situation = situations.pop()
    if situation != VINTAGE:
        raise SystemExit(
            "geometry vintage is %s, expected %s" % (situation, VINTAGE)
        )

    # --- cross-check against the REFNIS register ---------------------------
    refnis = read_refnis(refnis_path)
    munty_rows = [r for r in refnis if r["LVL_REFNIS"] == "4"]
    current = {r["CD_REFNIS"] for r in munty_rows
               if r["DT_VLDT_END"] == "31/12/9999"}
    retired = {r["CD_REFNIS"]: r for r in munty_rows
               if r["DT_VLDT_END"] in END_TO_VALID_FROM}

    if current != set(municipalities):
        only_reg = sorted(current - set(municipalities))
        only_geo = sorted(set(municipalities) - current)
        raise SystemExit(
            "register and geometry disagree on the current set: "
            "register-only %r geometry-only %r" % (only_reg, only_geo)
        )
    if set(merger_edges) != set(retired):
        raise SystemExit(
            "merger edges from geometry do not match retired codes in the "
            "register: geometry-only %r register-only %r"
            % (sorted(set(merger_edges) - set(retired)),
               sorted(set(retired) - set(merger_edges)))
        )

    names = {r["CD_REFNIS"]: r for r in munty_rows}
    fan_in = {}
    for new in merger_edges.values():
        fan_in[new] = fan_in.get(new, 0) + 1

    def plain(nis):
        """Statbel name with its parenthetical arrondissement suffix removed."""
        row = names[nis]
        out = []
        for key in ("TX_REFNIS_NL", "TX_REFNIS_FR"):
            v = row[key]
            if v.endswith(")") and "(" in v:
                v = v[:v.rindex("(")].strip()
            out.append(v)
        return tuple(out)

    history = []
    recodes = 0
    for old in sorted(merger_edges):
        new = merger_edges[old]
        if new not in current:
            raise SystemExit(
                "%s maps to %s, which is not a current municipality"
                % (old, new)
            )
        # A record is a pure re-coding when the old code is the sole
        # predecessor of the new one AND the name is unchanged. Name equality
        # alone is not enough: Deinze, Aalter, Hasselt, Lochristi, Lokeren,
        # Tielt, Wingene and Bastenaken are all real mergers whose successor
        # kept a predecessor's name. Fan-in alone is not enough either:
        # Borsbeek into Antwerpen has fan-in 1.
        recode = fan_in[new] == 1 and plain(old) == plain(new)
        src = ["statbel_refnis_2025", "statbel_sectors_2025"]
        if recode:
            recodes += 1
            src.append("walloon_decree_hainaut_arrondissements_2018")
        history.append({
            "kind": "recode" if recode else "merger",
            "old_fr": names[old]["TX_REFNIS_FR"],
            "old_nis": old,
            "old_nl": names[old]["TX_REFNIS_NL"],
            "new_nis": new,
            "src": sorted(src),
            "valid_from": END_TO_VALID_FROM[retired[old]["DT_VLDT_END"]],
        })

    if recodes != 11:
        raise SystemExit(
            "expected 11 Hainaut re-codings, classified %d" % recodes
        )

    return {
        "municipalities": municipalities,
        "regions": regions,
        "provinces": provinces,
        "districts": districts,
        "history": history,
        "sector_count": sector_count,
    }


def write_json(path, obj):
    """Minified, key-sorted, UTF-8, LF, exactly one trailing newline."""
    text = json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")) + "\n"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return len(text.encode("utf-8"))


def main(argv):
    if len(argv) != 3:
        print("usage: build_municipalities.py <sectors.geojson> <TU_COM_REFNIS.txt>")
        return 2
    out = build(argv[1], argv[2])

    n = len(out["municipalities"])
    if n != 565:
        raise SystemExit(
            "expected 565 municipalities for the %s vintage, found %d"
            % (VINTAGE, n)
        )

    muni_doc = {
        "sources": {k: SOURCES[k] for k in
                    ("statbel_sectors_2025", "statbel_refnis_2025")},
        "meta": {
            "count": n,
            "sector_count": out["sector_count"],
            "vintage": VINTAGE,
            "notes": [
                "Names are the plain official Statbel names, taken from the "
                "sector geometry. The REFNIS code list gives the same names "
                "but appends a parenthetical arrondissement to 15 homonyms "
                "(“Halle (Halle-Vilvoorde)”, “Tielt (Tielt)”) as a uniqueness "
                "device; that suffix is not part of the name and is not "
                "reproduced here. The only genuine disagreement between the "
                "two sources is the German name of NIS 82039, where the "
                "geometry gives the exonym Bastnach and the code list repeats "
                "the French Bastogne; the exonym is kept.",
                "prov is null for the 19 municipalities of the "
                "Brussels-Capital Region, which belongs to no province.",
                "No English names. English exists nowhere at source and is "
                "supplied only by the curated override in web/data/i18n/en.json.",
            ],
        },
        "municipalities": out["municipalities"],
        "regions": out["regions"],
        "provinces": out["provinces"],
        "districts": out["districts"],
    }

    hist_doc = {
        "meta": {
            "count": len(out["history"]),
            "vintage": VINTAGE,
            "notes": [
                "Every record is attested independently by both cited sources: "
                "the geometry supplies the old-to-new edge, the code list "
                "supplies the date. The build fails if they disagree.",
                "kind is \"merger\" when the old municipality ceased to exist, "
                "and \"recode\" when it survived unchanged under a new number. "
                "The distinction matters: a recode can be followed silently, "
                "whereas a merger means the old boundary no longer exists and "
                "any per-municipality figure crossing it is an aggregate.",
                "The 2019 wave has both kinds. Seven mergers retired 15 codes "
                "and created 7 (589 to 581 municipalities). The other 11 "
                "records are recodes from the Hainaut administrative-district "
                "reform. They still must pass through this table, or a "
                "pre-2019 statistic for La Louvière will silently fail to "
                "join.",
                "The 2025 wave retired 29 codes and created 13; Antwerpen "
                "absorbed Borsbeek while keeping NIS 11002, so 30 "
                "municipalities were affected and the count fell from 581 to "
                "565.",
                "Bastogne and Bertogne merged on 1 December 2024, a month "
                "before the Flemish wave. Their valid_from reflects that.",
                "Coverage is the 2019 and 2025 waves only. The 1977 "
                "amalgamation is out of scope: BeHERE ships no data older "
                "than 2019.",
            ],
        },
        "records": out["history"],
        "sources": SOURCES,
    }

    mp = os.path.join(WEB_DATA, "municipalities.json")
    hp = os.path.join(WEB_DATA, "nis_history.json")
    mb = write_json(mp, muni_doc)
    hb = write_json(hp, hist_doc)
    print("%s  %d municipalities  %d bytes" % (mp, n, mb))
    print("%s  %d records  %d bytes" % (hp, len(out["history"]), hb))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
