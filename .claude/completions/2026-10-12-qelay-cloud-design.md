# Qelay-Cloud design (2026-10-12)

**Done**: studied qelay and qelay-control-panel; wrote [DESIGN.md](../../DESIGN.md).

**Decisions made with the user**
- SDK + provider-based panel, no queue server of our own.
- GCP first, AWS second.
- Postgres as the job-state store on both clouds.
- Must-have: core queue + DLQ, delayed jobs + cron, job inspector, flows / workflows.

**Proposed in the design (not yet confirmed)**: Postgres authoritative with the cloud queue as a
"doorbell"; flows on Postgres dependency tables; panel copied and diverged.

**Not done**: no code, no scaffold, no panel copy. The ChatGPT share link
(https://chatgpt.com/share/6acc8d15-2e74-83ed-abeb-5f3b5bec40eb) returned only its title, so it was
not used.

**Next**: user answers the open questions in DESIGN.md section 10, then Phase 0 spikes.
