# The repo is public so that branch rulesets work on the free plan

GitHub Free gives private repos neither rulesets nor classic branch protection, so "merges to main only via PR" would be unenforceable without GitHub Pro (~$4/mo). We chose to make the repo public instead: rulesets are free on public repos. Nothing sensitive is tracked — the YouTube API key and the catalog database live only in gitignored local files. If the repo ever goes private again, the merge gate on main silently stops being enforced.
