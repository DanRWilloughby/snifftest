/**
 * The published executable.
 *
 * One line of work, and the reason it is its own file: a package manager
 * installs `node_modules/.bin/snifftest` as a symbolic link to whatever `bin`
 * names in `package.json`, and everything a user reaches for goes through that
 * link. `npx snifftest`, a global install, the GitHub Action, the pre-commit
 * framework entry. A bundle that decides whether to run by comparing its own
 * module URL with `argv[1]` gets that decision wrong through a link, because
 * Node resolves the link for one and not for the other, and the program then
 * ends having done nothing. Exit 0 with no output is this tool's word for
 * "nothing tripped", so the failure arrives as a clean bill of health.
 *
 * So the published entry asks no question. It calls `main`, always, and the
 * conditional that remains in `src/cli.ts` is there for running that file
 * directly during development.
 */

import { main } from "./cli.ts";

await main();
