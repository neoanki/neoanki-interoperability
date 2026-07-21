# Anki & CSV Interoperability

An isolated migration extension for Anki `.apkg` / `.colpkg` and CSV. Imports are inspected in the worker, committed only after explicit confirmation, validated by core, and protected by an automatic rollback checkpoint.
