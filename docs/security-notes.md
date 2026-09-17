# Security notes

A record of the decisions behind the security work, kept so that a reader who
disagrees with one can see what it was weighed against rather than guessing.
What the tool sends, when it asks and where keys come from belongs in
`SECURITY.md`, a reader's document that is being written and is not in the tree
yet. This one is for the choices.

## Considered and rejected

Each line is a thing a review raised, a decision, and the reason. A line here is
re-opened by new evidence, never by being raised again.

- **Running the checker from the Action's own directory instead of fetching it.**
  Rejected: `dist/` is not committed, and Bun is not on a GitHub runner, so
  running the code that ships with the Action would mean either committing a
  build artifact to the repository or adding a third-party setup action to the
  composite. The fetch stays, and the working directory moves out of the
  checkout instead, which is the same mechanism the hook and the skill use and
  is the smaller change to be sure of.
- **Adding `--root` to the `.pre-commit-hooks.yaml` entries.** Rejected: the
  framework installs `additional_dependencies` into an environment of its own
  under its cache and invokes the entry from that environment, so a repository's
  committed `node_modules/snifftest` is never what runs. That is the framework's
  documented behaviour rather than something measured here, and it is the reason
  those two entries were left alone while the hook, the skill and the Action all
  changed.
- **Making the pre-commit hook block a commit when the checker exits 2.**
  Rejected: an exit 2 means the checker never formed an opinion about the prose,
  and a hook that wedges every commit in a repository over a broken tool is
  worse than one that says what happened and steps aside. `SNIFFTEST_STRICT=1`
  is there for anyone who wants the other trade, and the hostile ruleset that
  prompted the question now fails as an ordinary parse error instead.
- **A depth cap on block-mapping nesting in the YAML reader.** Rejected: block
  nesting needs one line and one level of indentation per level, and twenty
  thousand levels parse without trouble, so there is nothing here to cap. The
  cap went on flow collections, where fifty thousand brackets fit on one line.
- **Matching re-encodings of a credential in the scrubber.** Rejected: the
  scrubber works by holding the value and taking it out, and base64, URL
  escaping or a hash of a value does not contain the characters of that value.
  Covering them would mean guessing at credential shapes, which is the heuristic
  this module was written to avoid. The doc comment names what is out of scope
  instead.
- **Refusing every event the Action has not been reasoned about.** Rejected in
  favour of forcing the countable rules on them. A hard refusal breaks a
  workflow that has a perfectly good reason to run the free rules on an event
  nobody here thought of, and the free rules send nothing, so the guard's
  promise holds without the breakage.
- **Keeping the entry guard in `src/cli.ts` alongside a dedicated bin file.**
  Rejected, after trying it: inside a bundle the guard is true, because the
  bundled module and `argv[1]` are the same file, so the program ran twice and
  printed its report twice. One file is the program and the other is a library,
  decided by which file it is rather than at run time, and `bun src/bin.ts` is
  now the way the repository runs the tool on itself.
- **Bumping `package.json` off `0.0.0` now.** Rejected: it is deliberately
  behind the pins until a release, because the release workflow compares it with
  the tag, and step one of the checklist in `docs/releasing.md` is to bump it.
  It is the first thing that has to happen to cut `v0.1.0`, which is what owning
  the name needs.

- **Refusing a hostile regular expression by shape, rather than by running it
  with a timeout.** Rejected on the timeout: nothing in JavaScript can interrupt
  a regular expression once it starts, so a timeout would have to be a worker,
  and that is a thread per rule to move a hang somewhere it can be killed. Two
  shapes are refused when the ruleset is read: a repetition applied to a group
  that already holds one, and a repeated group whose alternatives can match the
  same text. `(cat|dog)+` survives, because two branches that cannot begin on
  the same character give the engine one way through; `(a|a)+`, `(a|ab)+` and
  `(x|xx)*` do not, and `(a|a)+` was measured at 174 ms over twenty-four
  characters and roughly 1.84 per character after that. The false positive this
  costs, a branch whose first character cannot be read off the pattern, is a
  shape a prose ruleset does not write.

  Under both of those the pattern is run against strings of four to twenty-four
  characters before the ruleset is accepted, and one that climbs out of a few
  milliseconds in that range is refused with the length and the time. The
  lengths climb rather than jumping to the longest, because measuring the cost
  of a pattern is the one thing that can itself hang. That probe is a
  measurement on a short string and not a proof about a long one. The 8,000
  character cap on how much of a paragraph a ruleset's pattern reads is the last
  layer, and it is a cap on the length rather than on the cost: for a pattern
  that backtracks exponentially those are not the same thing, which is why the
  refusals are what this rests on.

- **Putting the answer cache next to the files being checked.** Rejected: a
  cache written into the directory under check is a file somebody commits
  without meaning to, and in a repository that is a record of which paragraphs
  were sent for judgment and what came back. It lives under the user's cache
  directory instead, named by `SNIFFTEST_CACHE_DIR` when somebody wants it
  elsewhere. A relative name there is resolved against the home directory, not
  the working directory, because during a check the working directory is the
  repository and that is the one place this file may not land. What it holds is
  deliberately thin: the paragraph is a hash in a file name, never text on disk,
  and the file itself carries rule ids, probabilities, the wording they
  answered, a model name and a date. A hash is not the text, though anyone who
  already has a paragraph can confirm it was checked, which is worth saying
  rather than calling the thing anonymous; the files are written 0600 inside
  0700 directories so that anyone is at least only the owner. Each one is
  written to a sibling temporary file and renamed into place, so a run killed
  mid-write leaves nothing torn and a symlink planted at the entry's path is
  replaced rather than followed.

  A shared cache directory is a different matter, and worth naming: point
  `SNIFFTEST_CACHE_DIR` at a restored CI cache that a fork's job can write and
  a poisoned entry reads back as a judgment nobody paid for. The reader
  validates hard, so an entry can only carry probabilities in range for the
  exact paragraph, questions and wording it claims to answer, but the numbers
  themselves would be the attacker's. Keep the cache per user, or turn it off in
  CI with `SNIFFTEST_CACHE_DIR=off`.

- **Following a `.snifftest.yaml` that is a symbolic link.** Rejected for a
  ruleset found by discovery, kept for one named with `--rules`. A file found by
  looking in the working directory is one nobody typed, and a link there reads a
  ruleset from somewhere else in the tree, or outside it, under a name that says
  the rules are local. The refusal names the file it is pointing at so the
  caller can name it themselves, which is the whole of the workaround. A path
  the caller typed is their own business, and refusing it would break a house
  ruleset kept in a dotfiles directory and linked in on purpose.

- **Waiting out a `Retry-After` past the cap.** Rejected. The cap used to be
  applied to the wait, so a header asking for an hour became an eight second
  wait, taken three times over, before reporting the same failure anyway. Past
  the cap the service is asking for more time than a check of somebody's prose
  is worth holding for, and the only question is whether that is reported now or
  in a minute. A header of zero is the other direction, a service asking to be
  hammered, and it gets the ladder's first step rather than no wait at all.

- **A timeout on the judgment arm instead of a budget.** Rejected: a timeout
  would throw away a run that has already been paid for. The arm is given a
  budget of twenty seconds for every paragraph it means to send, with a floor of
  a minute, consulted before each request. A request in flight finishes, every
  answer already received is kept, and the paragraphs that went unasked are
  named. Without it the breaker covers a service that fails and nothing covers
  one that answers slowly, which on a few hundred paragraphs is a hook with no
  ceiling.

## Owner actions

Things no change in this repository can settle.

- **Own `snifftest` on npm before the repository is public.** The reason and the
  order are the first section of `docs/releasing.md`.
- **Decide on the commit identity before the first push.** Every commit on
  `main` carries the same personal address as author and committer, and a push
  makes that a permanent public record. Rewrite the identity first if that is
  not intended.
