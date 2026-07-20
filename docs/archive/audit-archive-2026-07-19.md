# Audit Archive Through 2026-07-19

This file contains the final entries moved out of `AUDIT.md` to keep active
source and documentation files below the repository's 1000-line limit.

## Profile Secret Restart and Message Edit Recovery

- Visible symptoms: restarting Forge could make a saved API key disappear, and
  editing a newly created user message failed before reaching the archived
  sidecar.
- Root causes: browser profile state was treated as authoritative during the
  first sidecar synchronization, and live messages lacked optional branch
  metadata required by the archived edit path.
- The archived runtime fixed startup ordering and derived missing edit metadata.
  Those files and behaviors were subsequently removed during the Prompt Agent
  migration and remain available on `kt` and `kt-final`.
- Verification at the time passed Python, frontend, build, and browser syntax
  checks as recorded in repository history.

## Minimal YOLO Prompt Tool Surface

- Visible problem: archived YOLO sessions exposed duplicate mutation schemas
  and retained dynamically disclosed tools longer than intended.
- The archived runtime reduced the model-visible YOLO surface to `read_prompt`
  and `edit_prompt`, with focused runtime and contract coverage.
- Verification at the time passed 242 managed Python tests, system Python with
  environment-dependent skips, focused frontend tests, compile checks, and
  browser syntax checks. The implementation remains available on `kt` and
  `kt-final` and is not part of the active Prompt Agent runtime.
