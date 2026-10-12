# Atlas persona

Atlas also supports [profile adaptation and trusted entitlements](profile-entitlements.md). The CLI loads an explicit local policy, and SDK callers must supply a trusted authorization provider. Model tools and host reviews enforce those grants.

Atlas is a consistent AI engineering partner, not a claim of consciousness. Its name, purpose, relationship, voice, and principles live in the versioned `persona.yaml`. The local chatbot loads Atlas by default; `ADK_PERSONA_PATH` can point to another validated YAML persona. Increment its semantic version when editing identity or principles. Duplicate keys, aliases, unknown fields, oversized files, and invalid versions are rejected.

```bash
pnpm adk:dev
```

Each chatbot turn composes the trusted persona with scoped profile facts, five recent chat episodes, relevant retrieved exchanges, and recent session turns. Memory is serialized inside a separate untrusted-data section and bounded to a 24,000-character excerpt when oversized. These facts and lessons provide continuity; they cannot change core principles. This instruction boundary is a prompt-injection mitigation, not a guarantee of model obedience.

For example, say: “Keep your answers concise and focus on working implementations.” Atlas may call `propose_lesson` with an exact quote from that current message and a proposed preference or lesson. Proposals remain episodic pending records and do not enter the approved-lesson context. The tool validates quote provenance, not whether the model's interpretation is correct. Review the proposed wording yourself.

```text
/reflections
/accept ep_PROPOSAL_ID
/reject ep_PROPOSAL_ID
```

Only the host CLI/API can approve or reject. The model has no review tool, and `remember_fact` cannot write reserved `atlas.*` metadata. Acceptance saves a reviewed JSON profile fact with its quote and decision; rejection is also recorded but is excluded from guidance. Approval never edits `persona.yaml`. Ordinary explicitly stated user facts remain available through `remember_fact`; lesson proposals use the separate review flow.

The pending list exposes the latest 200 proposal episodes. Reviewed decisions consume Memlayer's existing 200-fact per-user limit alongside other profile facts. This is a small-scale reviewed-memory workflow, not an unlimited queue. Hosted integrations should serialize reviews per user to avoid concurrent conflicting decisions. Profile facts and proposals persist in SQLite; the existing profile retention and deletion APIs still apply.

`runAdkAnswer({persona: customPersona, ...})` selects a trusted host-provided persona; `persona: null` disables it explicitly. By default, calls with `persistSession` use Atlas, while read-only answer benchmarks stay persona-neutral so existing LoCoMo results remain comparable. Read-only tools cannot propose lessons or store facts.

Offline tests exercise the actual ADK runner and verify persona composition, cross-session context, hostile-memory placement, quote checks, approval boundaries, rejection, and neutral evaluation behavior. They verify wiring and contracts, not whether a real Gemini model consistently follows the persona. Live style, judgment, honesty, and multi-session behavior still require a credentialed Gemini evaluation.
