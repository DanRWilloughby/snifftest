# Security notes

A record of the decisions behind the security work, kept so that a reader who
disagrees with one can see what it was weighed against rather than guessing.
What the tool sends, when it asks and where keys come from belongs in
`SECURITY.md`, which is a reader's document. This one is for the choices.

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

## Owner actions

Things no change in this repository can settle.

- **Own `snifftest` on npm before the repository is public.** The reason and the
  order are the first section of `docs/releasing.md`.
- **Decide on the commit identity before the first push.** Every commit on
  `main` carries the same personal address as author and committer, and a push
  makes that a permanent public record. Rewrite the identity first if that is
  not intended.
