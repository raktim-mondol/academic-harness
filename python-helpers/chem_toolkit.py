"""Local chemistry computations (RDKit). JSON request on stdin, JSON on stdout.

Request: {"action": ..., "molecules": [...], "path": str|null, ...}
Actions: validate, standardize, descriptors, similarity, substructure, conformers.
Never invents a result: an unparsable structure is reported as invalid with the
RDKit reason, and a cap on molecule count is stated in the output.
"""
from __future__ import annotations

import json
import sys

MAX_MOLS = 5000


def emit(value):
    print(json.dumps(value))
    sys.exit(0)


def fail(message, code=None):
    emit({"error": message, **({"code": code} if code else {})})


try:
    from rdkit import Chem, DataStructs, RDLogger, rdBase
    from rdkit.Chem import AllChem, Descriptors, Lipinski, rdMolDescriptors
    from rdkit.Chem.MolStandardize import rdMolStandardize

    RDLogger.DisableLog("rdApp.*")
except ImportError as exc:  # pragma: no cover - environment dependent
    fail(f"chem_toolkit needs RDKit; run: cd python-helpers && uv sync ({exc})", "rdkit_missing")


def read_inputs(request):
    """Return [(label, mol_or_None, source_text, error)] and a note about capping."""
    items = []
    path = request.get("path")
    if path:
        lowered = path.lower()
        if lowered.endswith((".sdf", ".sd", ".mol")):
            supplier = Chem.SDMolSupplier(path, sanitize=True)
            for index, mol in enumerate(supplier):
                if index >= MAX_MOLS:
                    break
                name = mol.GetProp("_Name") if mol is not None and mol.HasProp("_Name") else ""
                items.append((name or f"mol{index + 1}", mol, None, None if mol is not None else "RDKit could not parse this SDF record"))
            total = sum(1 for _ in Chem.SDMolSupplier(path, sanitize=False))
        else:
            lines = [ln.strip() for ln in open(path, encoding="utf-8", errors="replace").read().splitlines() if ln.strip() and not ln.startswith("#")]
            total = len(lines)
            for index, line in enumerate(lines[:MAX_MOLS]):
                parts = line.split(None, 1)
                items.append(make_item(parts[0], parts[1] if len(parts) > 1 else f"mol{index + 1}"))
    else:
        raw = request.get("molecules") or []
        total = len(raw)
        for index, entry in enumerate(raw[:MAX_MOLS]):
            parts = str(entry).strip().split(None, 1)
            if not parts:
                items.append((f"mol{index + 1}", None, "", "empty input"))
                continue
            items.append(make_item(parts[0], parts[1] if len(parts) > 1 else f"mol{index + 1}"))
    note = None
    if total > MAX_MOLS:
        note = f"input has {total} structures; only the first {MAX_MOLS} were processed"
    return items, total, note


def make_item(smiles, label):
    mol = Chem.MolFromSmiles(smiles)
    return (label, mol, smiles, None if mol is not None else "RDKit could not parse this SMILES")


def smi(mol):
    return Chem.MolToSmiles(mol)


def action_validate(request):
    items, total, note = read_inputs(request)
    rows = []
    for label, mol, source, error in items:
        if mol is None:
            rows.append({"name": label, "input": source, "valid": False, "error": error})
        else:
            rows.append({"name": label, "input": source, "valid": True, "canonical_smiles": smi(mol), "formula": rdMolDescriptors.CalcMolFormula(mol), "heavy_atoms": mol.GetNumHeavyAtoms()})
    return {"count": len(rows), "total_in_input": total, "valid": sum(1 for r in rows if r["valid"]), "invalid": sum(1 for r in rows if not r["valid"]), "rows": rows, "note": note}


def action_standardize(request):
    items, total, note = read_inputs(request)
    chooser = rdMolStandardize.LargestFragmentChooser()
    uncharger = rdMolStandardize.Uncharger()
    tautomerize = bool(request.get("tautomer"))
    enumerator = rdMolStandardize.TautomerEnumerator() if tautomerize else None
    rows = []
    for label, mol, source, error in items:
        if mol is None:
            rows.append({"name": label, "input": source, "ok": False, "error": error})
            continue
        steps = ["cleanup", "largest_fragment", "uncharge"]
        try:
            clean = rdMolStandardize.Cleanup(mol)
            clean = chooser.choose(clean)
            clean = uncharger.uncharge(clean)
            if enumerator is not None:
                clean = enumerator.Canonicalize(clean)
                steps.append("canonical_tautomer")
            rows.append({"name": label, "input": source, "ok": True, "standardized_smiles": smi(clean), "inchikey": Chem.MolToInchiKey(clean) or None, "changed": smi(mol) != smi(clean), "steps": steps})
        except Exception as exc:  # noqa: BLE001
            rows.append({"name": label, "input": source, "ok": False, "error": f"standardization failed: {exc}"})
    return {"count": len(rows), "total_in_input": total, "rows": rows, "note": note, "steps_note": "salts are stripped by keeping the largest fragment; review rows with changed=true before relying on identity"}


def action_descriptors(request):
    items, total, note = read_inputs(request)
    rows = []
    for label, mol, source, error in items:
        if mol is None:
            rows.append({"name": label, "input": source, "valid": False, "error": error})
            continue
        mw = Descriptors.MolWt(mol)
        logp = Descriptors.MolLogP(mol)
        hbd = Lipinski.NumHDonors(mol)
        hba = Lipinski.NumHAcceptors(mol)
        rows.append({
            "name": label, "input": source, "valid": True, "canonical_smiles": smi(mol),
            "formula": rdMolDescriptors.CalcMolFormula(mol),
            "mol_weight": round(mw, 3), "exact_mass": round(Descriptors.ExactMolWt(mol), 4),
            "logp_crippen": round(logp, 3), "tpsa": round(rdMolDescriptors.CalcTPSA(mol), 2),
            "hbd": hbd, "hba": hba, "rotatable_bonds": rdMolDescriptors.CalcNumRotatableBonds(mol),
            "rings": rdMolDescriptors.CalcNumRings(mol), "aromatic_rings": rdMolDescriptors.CalcNumAromaticRings(mol),
            "heavy_atoms": mol.GetNumHeavyAtoms(), "formal_charge": Chem.GetFormalCharge(mol),
            "rule_of_five_violations": int(mw > 500) + int(logp > 5) + int(hbd > 5) + int(hba > 10),
        })
    return {"count": len(rows), "total_in_input": total, "rows": rows, "note": note, "caveat": "logP is the Crippen estimate and the rule-of-five count is a screening heuristic, not a measured property or a drug-likeness verdict"}


def fingerprint(mol, radius, bits):
    return AllChem.GetMorganFingerprintAsBitVect(mol, radius, nBits=bits)


def action_similarity(request):
    query_text = (request.get("query") or "").strip()
    if not query_text:
        fail("query (a SMILES string) is required for similarity")
    query = Chem.MolFromSmiles(query_text)
    if query is None:
        fail("query is not a valid SMILES")
    radius = int(request.get("radius") or 2)
    bits = int(request.get("n_bits") or 2048)
    threshold = float(request.get("threshold") or 0.0)
    top_k = int(request.get("top_k") or 20)
    qfp = fingerprint(query, radius, bits)
    items, total, note = read_inputs(request)
    scored, invalid = [], []
    for label, mol, source, error in items:
        if mol is None:
            invalid.append({"name": label, "input": source, "error": error})
            continue
        score = DataStructs.TanimotoSimilarity(qfp, fingerprint(mol, radius, bits))
        if score >= threshold:
            scored.append({"name": label, "input": source, "canonical_smiles": smi(mol), "tanimoto": round(score, 4)})
    scored.sort(key=lambda row: -row["tanimoto"])
    return {"query": smi(query), "fingerprint": f"Morgan radius {radius}, {bits} bits", "compared": len(items) - len(invalid), "returned": min(len(scored), top_k), "above_threshold": len(scored), "rows": scored[:top_k], "invalid": invalid[:20], "invalid_count": len(invalid), "total_in_input": total, "note": note, "caveat": "Tanimoto similarity depends on the fingerprint; it is not evidence of shared activity"}


def action_substructure(request):
    pattern_text = (request.get("pattern") or "").strip()
    if not pattern_text:
        fail("pattern (a SMARTS or SMILES query) is required for substructure")
    pattern = Chem.MolFromSmarts(pattern_text)
    if pattern is None:
        fail("pattern is not valid SMARTS")
    items, total, note = read_inputs(request)
    hits, invalid = [], 0
    for label, mol, source, error in items:
        if mol is None:
            invalid += 1
            continue
        matches = mol.GetSubstructMatches(pattern)
        if matches:
            hits.append({"name": label, "input": source, "canonical_smiles": smi(mol), "match_count": len(matches), "first_match_atoms": list(matches[0])})
    return {"pattern": pattern_text, "searched": len(items) - invalid, "matches": len(hits), "rows": hits[:200], "truncated": len(hits) > 200, "invalid_count": invalid, "total_in_input": total, "note": note}


def action_conformers(request):
    items, total, note = read_inputs(request)
    if not items:
        fail("conformers needs at least one valid structure")
    n = max(1, min(int(request.get("n_conformers") or 10), 50))
    seed = int(request.get("seed") if request.get("seed") is not None else 42)
    out_path = request.get("out_path")
    writer = Chem.SDWriter(out_path) if out_path else None
    rows = []
    for label, mol, source, error in items[:20]:
        if mol is None:
            rows.append({"name": label, "input": source, "ok": False, "error": error})
            continue
        molh = Chem.AddHs(mol)
        ids = list(AllChem.EmbedMultipleConfs(molh, numConfs=n, randomSeed=seed))
        if not ids:
            rows.append({"name": label, "input": source, "ok": False, "error": "embedding failed (no conformers generated)"})
            continue
        results = AllChem.MMFFOptimizeMoleculeConfs(molh, maxIters=2000) if AllChem.MMFFHasAllMoleculeParams(molh) else None
        if results is None:
            energies, force_field = None, "none (MMFF parameters unavailable for this molecule)"
        else:
            energies = [round(e, 3) for (_, e) in results]
            force_field = "MMFF94"
        if writer is not None:
            for cid in ids:
                molh.SetProp("_Name", f"{label}_conf{cid}")
                if energies is not None:
                    molh.SetProp("MMFF_energy_kcal_mol", str(energies[ids.index(cid)]))
                writer.write(molh, confId=cid)
        row = {"name": label, "input": source, "ok": True, "conformers": len(ids), "force_field": force_field, "seed": seed}
        if energies is not None:
            lowest = min(energies)
            row.update({"lowest_energy_kcal_mol": lowest, "energy_range_kcal_mol": round(max(energies) - lowest, 3)})
        rows.append(row)
    if writer is not None:
        writer.close()
    return {"rows": rows, "processed": len(rows), "total_in_input": total, "note": note or ("only the first 20 structures are embedded" if len(items) > 20 else None), "written": out_path, "caveat": "ETKDG conformers relaxed with MMFF94 are a sampling of low-energy geometries, not a global minimum or a quantum-chemical result"}


ACTIONS = {
    "validate": action_validate,
    "standardize": action_standardize,
    "descriptors": action_descriptors,
    "similarity": action_similarity,
    "substructure": action_substructure,
    "conformers": action_conformers,
}


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        fail(f"invalid request JSON: {exc}")
    action = request.get("action")
    if action not in ACTIONS:
        fail(f"action must be one of {', '.join(ACTIONS)}")
    if not request.get("molecules") and not request.get("path"):
        fail("molecules (an array of SMILES) or path is required")
    try:
        result = ACTIONS[action](request)
    except Exception as exc:  # noqa: BLE001
        fail(f"{action} failed: {exc}")
    result["tool_versions"] = {"rdkit": rdBase.rdkitVersion}
    emit({"action": action, **result})


if __name__ == "__main__":
    main()
