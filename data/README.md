# Soma Data Directory

Soma stores all runtime state here:

- `knowledge_graph.json` — persistent knowledge base (built over time)
- `soma_journal.json` — cycle-by-cycle autonomy log
- `soma_journal.md` — human-readable version of the last 48 journal cycles
- `learner_state.json` — learned inference rules
- `associator_cache.json` — emergent concept cache
- `sleep_state.json` — active thread warmth tracking
- `pulse_state.json` — cycle history and dedup keys
- `thoughtstream.json` — questions, hypotheses, insights (the reasoning layer)
- `session_narratives.json` — episodic session records
- `consolidator_state.json` — Consolidator cursor (last processed narrative)
- `session_lock.json` — session coordination state (background lock)
- `daemon.pid` — daemon process guard (auto-deleted on exit)
- `action_queue.json` — pending autonomous actions (if action pipeline is used)

These files are gitignored. They contain your personal knowledge and are built up by Soma over time as it processes sessions, sensors, and reasoning cycles.

**To start fresh:** delete all `.json` files in this directory (keep the directory itself and `.gitkeep`).

**To backup your knowledge:** copy `knowledge_graph.json`, `thoughtstream.json`, and `soma_journal.json` — those three files contain the bulk of accumulated state.
