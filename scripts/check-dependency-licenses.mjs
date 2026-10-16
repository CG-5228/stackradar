#!/usr/bin/env node
/**
 * Dependency licence gate.
 *
 * The server and client are AGPL-3.0-only, and the images that ship them
 * carry every runtime dependency. A dependency under a licence the AGPL
 * cannot be combined with, or under no stated licence at all, would make
 * the images undistributable and is the first thing an enterprise's
 * compliance scanner reports. This script turns "the dependencies are
 * fine" into a check that runs whenever a lockfile changes.
 *
 * It asks pnpm for the licence of every *runtime* package
 * (`pnpm licenses list --prod --json`, which reads each package's own
 * package.json), parses the SPDX expression pnpm reports, and fails on any
 * package whose expression is not satisfied by ALLOWED:
 *
 *  - `A OR B`  passes when either side passes (we take the one we like);
 *  - `A AND B` passes only when both do;
 *  - a bare id passes when it is in ALLOWED.
 *
 * ALLOWED is permissive and weak-copyleft licences that are compatible with
 * AGPL-3.0 and need nothing beyond keeping notices. Strong-copyleft ids
 * (GPL-*) are deliberately absent even though GPL-3.0 is AGPL-compatible:
 * they are rare enough in npm that a human should look at each one and
 * record it in EXCEPTIONS with the reason. `Unknown`, `UNLICENSED` and an
 * empty field always fail; a package that states no licence grants no
 * rights.
 *
 * Dev dependencies are not checked: they never ship.
 *
 * Usage, from the repository root, after `pnpm install` in the app:
 *
 *   node scripts/check-dependency-licenses.mjs server
 *   node scripts/check-dependency-licenses.mjs client
 *   node scripts/check-dependency-licenses.mjs          # both
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["server", "client"];

/** SPDX ids a runtime dependency may carry without anyone looking. */
const ALLOWED = new Set([
    "MIT",
    "MIT-0",
    "ISC",
    "0BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD-3-Clause-Clear",
    "Apache-2.0",
    "MPL-2.0",
    "LGPL-2.1",
    "LGPL-2.1-only",
    "LGPL-2.1-or-later",
    "LGPL-3.0",
    "LGPL-3.0-only",
    "LGPL-3.0-or-later",
    "Unlicense",
    "CC0-1.0",
    "CC-BY-3.0",
    "CC-BY-4.0",
    "BlueOak-1.0.0",
    "Python-2.0",
    "PSF-2.0",
    "Zlib",
    "OFL-1.1",
    "Artistic-2.0",
    "WTFPL",
]);

/**
 * Packages accepted although their expression fails the rule above. One
 * entry per package name, with the reason a reader can check. Empty today.
 * @type {Record<string, string>}
 */
const EXCEPTIONS = {};

// --- SPDX expression evaluation --------------------------------------------

/** Tokenise an SPDX expression into ids, AND, OR, WITH and parentheses. */
function tokenize(expression) {
    return expression
        .replace(/\(/g, " ( ")
        .replace(/\)/g, " ) ")
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * Recursive-descent evaluation. Grammar (precedence low → high):
 *   or   := and ( "OR" and )*
 *   and  := unit ( "AND" unit )*
 *   unit := "(" or ")" | id [ "WITH" exception ]
 * A `WITH` exception is evaluated on the base id; the exception only ever
 * loosens the licence.
 */
function satisfies(expression) {
    const tokens = tokenize(expression);
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];

    function unit() {
        const t = take();
        if (t === undefined) throw new Error("unexpected end of expression");
        if (t === "(") {
            const value = or();
            if (take() !== ")") throw new Error("missing ')'");
            return value;
        }
        if (t === ")" || t === "AND" || t === "OR" || t === "WITH") {
            throw new Error(`unexpected '${t}'`);
        }
        let id = t;
        if (peek() === "WITH") {
            take();
            take();
        }
        // Deprecated "+" suffix (e.g. "GPL-2.0+") means or-later.
        if (id.endsWith("+")) id = `${id.slice(0, -1)}-or-later`;
        return ALLOWED.has(id);
    }
    function and() {
        let value = unit();
        while (peek() === "AND") {
            take();
            value = unit() && value;
        }
        return value;
    }
    function or() {
        let value = and();
        while (peek() === "OR") {
            take();
            value = and() || value;
        }
        return value;
    }

    const result = or();
    if (pos !== tokens.length) throw new Error(`trailing tokens after '${tokens[pos - 1]}'`);
    return result;
}

// --- Per-app check ---------------------------------------------------------

function listRuntimeLicenses(app) {
    const cwd = join(ROOT, app);
    if (!existsSync(join(cwd, "node_modules"))) {
        throw new Error(`${app}/node_modules is missing; run 'pnpm install' in ${app}/ first`);
    }
    const out = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    if (parsed.error) throw new Error(`pnpm licenses failed in ${app}/: ${parsed.error.message}`);
    // { "<expression>": [ { name, versions, license, homepage, ... } ] }
    return Object.entries(parsed).flatMap(([expression, packages]) =>
        packages.map((p) => ({ name: p.name, versions: p.versions ?? [], expression })),
    );
}

function checkApp(app) {
    const packages = listRuntimeLicenses(app);
    const failures = [];
    const byExpression = new Map();

    for (const pkg of packages) {
        byExpression.set(pkg.expression, (byExpression.get(pkg.expression) ?? 0) + 1);
        const expression = pkg.expression.trim();
        if (pkg.name in EXCEPTIONS) continue;
        let ok = false;
        let note = "";
        if (expression === "" || /^(unknown|unlicensed|see license.*)$/i.test(expression)) {
            note = "no usable licence statement";
        } else {
            try {
                ok = satisfies(expression);
            } catch (err) {
                note = `unparseable SPDX expression (${err.message})`;
            }
        }
        if (!ok) failures.push({ ...pkg, note });
    }

    console.log(`${app}: ${packages.length} runtime packages`);
    for (const [expression, count] of [...byExpression].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  ${expression || "(none)"}`);
    }
    for (const [name, reason] of Object.entries(EXCEPTIONS)) {
        if (packages.some((p) => p.name === name)) console.log(`  exception: ${name} (${reason})`);
    }

    if (failures.length > 0) {
        console.error(`\n${app}: ${failures.length} runtime package(s) need a look:`);
        for (const f of failures) {
            const why = f.note ? ` — ${f.note}` : "";
            console.error(`  ${f.name}@${f.versions.join(",")}: ${JSON.stringify(f.expression)}${why}`);
        }
        console.error(
            "\nEither the licence is fine for an AGPL-3.0 image and belongs in ALLOWED, or the package\n" +
                "is accepted for a reason worth recording in EXCEPTIONS, or it has to go.\n" +
                "Both lists are in scripts/check-dependency-licenses.mjs.",
        );
    }
    return failures.length === 0;
}

const apps = process.argv.slice(2);
const targets = apps.length > 0 ? apps : APPS;
for (const app of targets) {
    if (!APPS.includes(app)) {
        console.error(`unknown app '${app}'; expected one of ${APPS.join(", ")}`);
        process.exit(2);
    }
}

let allOk = true;
for (const app of targets) {
    try {
        if (!checkApp(app)) allOk = false;
    } catch (err) {
        console.error(`${app}: ${err.message}`);
        allOk = false;
    }
    console.log("");
}
process.exit(allOk ? 0 : 1);
