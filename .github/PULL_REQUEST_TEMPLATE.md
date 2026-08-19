## What this changes

<!-- and why. If it fixes an issue, link it. -->

## Checklist

- [ ] `npm test` passes
- [ ] No third-party dependency was added
- [ ] User-visible strings and their test assertions were changed in the same commit
- [ ] If a code path can fail, its failure cannot be mistaken for success — and a test says so

## Did you run board on it?

This project reviews itself; that is the whole point, and doing so found 14 real defects
during the extraction alone — including several in the fixes for earlier findings.

- [ ] I ran `/board` on this diff

If a reviewer raised a blocking item you disagree with, **declining it with a reason is a
legitimate outcome** — it is a necessary condition for the debate to converge at all. Say
which ones you declined and why.
