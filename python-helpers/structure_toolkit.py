"""Local structure computations (gemmi). JSON request on stdin, JSON on stdout.

Actions: chains, ligands, contacts, superpose. Reads PDB / mmCIF only from
paths the caller already confined to the workspace. Large outputs are capped
and say so; nothing is rendered or fetched here.
"""
from __future__ import annotations

import json
import sys

MAX_SEQ = 5000
MAX_ROWS = 200


def emit(value):
    print(json.dumps(value))
    sys.exit(0)


def fail(message, code=None):
    emit({"error": message, **({"code": code} if code else {})})


try:
    import gemmi
except ImportError as exc:  # pragma: no cover - environment dependent
    fail(f"structure_toolkit needs gemmi; run: cd python-helpers && uv sync ({exc})", "gemmi_missing")


def load(path):
    try:
        st = gemmi.read_structure(path)
    except Exception as exc:  # noqa: BLE001
        fail(f"could not read {path}: {exc}", "unreadable")
    if len(st) == 0 or st[0].count_atom_sites() == 0:
        fail(f"{path} contains no models or atoms; is it a PDB or mmCIF file?", "empty")
    st.setup_entities()
    return st


def summary(st):
    model = st[0]
    return {
        "models": len(st), "chains_in_first_model": len(model), "atoms_in_first_model": model.count_atom_sites(),
        "resolution": st.resolution or None, "spacegroup": st.spacegroup_hm or None,
    }


def polymer_info(chain):
    poly = chain.get_polymer()
    if len(poly) == 0:
        return None
    ptype = poly.check_polymer_type()
    seq = gemmi.one_letter_code([r.name for r in poly])
    return {
        "chain": chain.name, "polymer_type": str(ptype).split(".")[-1], "residues": len(poly),
        "first_residue": poly[0].seqid.num, "last_residue": poly[len(poly) - 1].seqid.num,
        "sequence": seq[:MAX_SEQ], "sequence_truncated": len(seq) > MAX_SEQ,
    }


def action_chains(st, request):
    model = st[0]
    rows = []
    for chain in model:
        info = polymer_info(chain)
        row = info or {"chain": chain.name, "polymer_type": None, "residues": 0}
        row["ligand_residues"] = len(chain.get_ligands())
        row["water_residues"] = len(chain.get_waters())
        rows.append(row)
    return {"structure": summary(st), "chains": rows, "alternate_models_note": "only the first model is reported" if len(st) > 1 else None}


def action_ligands(st, request):
    model = st[0]
    rows, counts = [], {}
    for chain in model:
        for res in chain.get_ligands():
            rows.append({"chain": chain.name, "name": res.name, "seq": res.seqid.num, "atoms": len(res)})
            counts[res.name] = counts.get(res.name, 0) + 1
    return {
        "structure": summary(st), "distinct": dict(sorted(counts.items())), "residues": len(rows), "rows": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS,
        "caveat": "non-polymer, non-water residues as deposited. Ions, buffers, and crystallization additives appear here; a listed residue is not evidence of a functionally relevant bound ligand",
    }


def select_atoms(model, spec):
    """A chain id, or a residue (ligand) name. Returns a predicate over (chain, residue)."""
    chain_ids = {c.name for c in model}
    if spec in chain_ids:
        return lambda chain, res: chain == spec, f"chain {spec}"
    return lambda chain, res: res == spec, f"residue name {spec}"


def action_contacts(st, request):
    spec_a, spec_b = request.get("selection_a"), request.get("selection_b")
    if not spec_a or not spec_b:
        fail("contacts needs selection_a and selection_b (each a chain id or a residue name such as HEM)")
    cutoff = float(request.get("cutoff") or 4.0)
    if not 1.0 <= cutoff <= 8.0:
        fail("cutoff must be between 1 and 8 angstrom")
    model = st[0]
    in_a, label_a = select_atoms(model, spec_a)
    in_b, label_b = select_atoms(model, spec_b)
    include_waters = bool(request.get("include_waters"))
    ns = gemmi.NeighborSearch(model, st.cell, max(5.0, cutoff)).populate()
    cs = gemmi.ContactSearch(cutoff)
    cs.ignore = gemmi.ContactSearch.Ignore.AdjacentResidues
    pairs = {}
    atom_pairs = 0
    for contact in cs.find_contacts(ns):
        p1, p2 = contact.partner1, contact.partner2
        for x, y in ((p1, p2), (p2, p1)):
            if in_a(x.chain.name, x.residue.name) and in_b(y.chain.name, y.residue.name):
                if not include_waters and "HOH" in (x.residue.name, y.residue.name):
                    continue
                if (x.chain.name, x.residue.seqid.num) == (y.chain.name, y.residue.seqid.num):
                    continue
                key = (x.chain.name, x.residue.name, x.residue.seqid.num, y.chain.name, y.residue.name, y.residue.seqid.num, contact.image_idx != 0)
                atom_pairs += 1
                if key not in pairs or contact.dist < pairs[key]:
                    pairs[key] = contact.dist
                break
    rows = [
        {"a_chain": k[0], "a_residue": k[1], "a_seq": k[2], "b_chain": k[3], "b_residue": k[4], "b_seq": k[5], "min_distance": round(d, 2), "symmetry_mate": k[6]}
        for k, d in sorted(pairs.items(), key=lambda kv: kv[1])
    ]
    return {
        "structure": summary(st), "selection_a": label_a, "selection_b": label_b, "cutoff_angstrom": cutoff,
        "residue_pairs": len(rows), "atom_pairs": atom_pairs, "rows": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS,
        "caveat": "a distance cutoff lists proximity, not interaction type or energy; hydrogen bonds, salt bridges, and clashes need their own criteria. Rows with symmetry_mate=true are crystal-packing neighbours, not the same asymmetric unit; they appear only if the file defines a unit cell",
    }


def action_superpose(st, request):
    path2 = request.get("path2")
    if not path2:
        fail("superpose needs path2 (the structure to move onto path)")
    st2 = load(path2)
    chain1 = request.get("chain") or st[0][0].name
    chain2 = request.get("chain2") or chain1
    atoms = request.get("atoms") or "ca"
    if atoms not in ("ca", "backbone"):
        fail("atoms must be ca or backbone")
    sel = gemmi.SupSelect.CaP if atoms == "ca" else gemmi.SupSelect.MainChain
    try:
        poly1 = st[0][chain1].get_polymer()
        poly2 = st2[0][chain2].get_polymer()
    except Exception:  # noqa: BLE001
        fail(f"chain {chain1} / {chain2} not found in the given structures", "chain_missing")
    if len(poly1) == 0 or len(poly2) == 0:
        fail("one of the selected chains has no polymer residues", "no_polymer")
    ptype = poly1.check_polymer_type()
    sup = gemmi.calculate_superposition(poly1, poly2, ptype, sel)
    mat, vec = sup.transform.mat.tolist(), sup.transform.vec.tolist()
    return {
        "fixed": {"chain": chain1, "residues": len(poly1)}, "moving": {"chain": chain2, "residues": len(poly2)},
        "atoms": "C-alpha" if atoms == "ca" else "backbone", "matched_atoms": sup.count, "rmsd_angstrom": round(sup.rmsd, 3),
        "transform": {"rotation": [[round(v, 5) for v in row] for row in mat], "translation": [round(v, 4) for v in vec]},
        "caveat": "residues are paired by a sequence alignment inside gemmi and the RMSD covers only matched atoms; a low RMSD on a short or trimmed match is weak evidence of similarity, and no structure is written",
    }


ACTIONS = {"chains": action_chains, "ligands": action_ligands, "contacts": action_contacts, "superpose": action_superpose}


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"invalid request JSON: {exc}")
    action = request.get("action")
    if action not in ACTIONS:
        fail(f"action must be one of {', '.join(ACTIONS)}")
    if not request.get("path"):
        fail("path is required")
    st = load(request["path"])
    try:
        result = ACTIONS[action](st, request)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(f"{action} failed: {exc}")
    emit({"action": action, **result, "tool_versions": {"gemmi": gemmi.__version__}})


if __name__ == "__main__":
    main()
