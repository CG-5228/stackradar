#!/usr/bin/env node
// Deletes what snapshot builds leave behind in GHCR.
//
//   GITHUB_TOKEN=… node scripts/ghcr-prune.mjs stackradar-server stackradar-client            # dry run
//   GITHUB_TOKEN=… node scripts/ghcr-prune.mjs --delete --keep-days 14 stackradar-server …     # for real
//
// Every merge to main moves the `:snapshot` tag (snapshot.yaml). The index
// it used to point at, that index's children (the amd64 image and its
// provenance attestation) and its cosign signature all stay behind, so the
// package grows by three or four versions per merge and nothing ever
// references them again. Released versions are immutable and never lose
// their tag (RELEASING.md), so they are not what this prunes.
//
// "Untagged" is not "unreferenced". A tagged image index (`:0.1.0`,
// `:snapshot`) is a list of untagged per-platform and attestation manifests,
// and a cosign signature is either a manifest tagged `sha256-<digest>.sig`
// or, stored OCI-1.1 style, an untagged manifest whose `subject` is the
// image, reachable through a `sha256-<digest>` fallback tag. Deleting any of
// those breaks `docker pull` or `cosign verify` of a release. So this walks
// the graph instead: a version is kept when it carries a real tag, is
// younger than --keep-days (a build in flight pushes its children before it
// tags the index), is listed by a kept index, or signs or attests a kept
// version. Everything else is unreachable and goes. Signatures of a pruned
// snapshot are unreachable by that definition, so they go in the same run.
//
// Bare node, no dependencies, like the other scripts/ checks. Needs a token
// that can delete versions of the packages: in Actions, GITHUB_TOKEN with
// `packages: write`, which works because the packages were first pushed from
// this repository's workflows and so list it with the admin role.
import { parseArgs } from "node:util";

const { values: opts, positionals: packages } = parseArgs({
    allowPositionals: true,
    options: {
        delete: { type: "boolean", default: false },
        "keep-days": { type: "string", default: "14" },
        owner: { type: "string", default: process.env.GITHUB_REPOSITORY_OWNER ?? "lockdep" },
    },
});

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const keepDays = Number(opts["keep-days"]);
if (packages.length === 0 || !Number.isFinite(keepDays) || keepDays < 0) {
    console.error("usage: ghcr-prune.mjs [--delete] [--keep-days N] [--owner ORG] <package>...");
    process.exit(2);
}
if (!token) {
    console.error("GITHUB_TOKEN is not set: listing is public but deleting is not.");
    process.exit(2);
}

const api = `https://api.github.com/orgs/${opts.owner}/packages/container`;
const apiHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
};

// `sha256-<digest>.sig` / `.att` / `.sbom` are cosign's tag-based layout;
// a bare `sha256-<digest>` is the OCI referrers fallback tag: an index
// listing the manifests whose `subject` is that digest.
const POINTER_TAG = /^sha256-([0-9a-f]{64})(\.sig|\.att|\.sbom)?$/;
const MANIFEST_ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
let failed = 0;
let deleted = 0;

for (const pkg of packages) {
    console.log(`\n== ghcr.io/${opts.owner}/${pkg}`);
    const versions = await listVersions(pkg);
    if (versions === null) {
        console.log("   no such package; nothing to prune");
        continue;
    }
    const byDigest = new Map(versions.map((v) => [v.name, v]));
    const manifests = new Map(); // digest → parsed manifest (or null when unreadable)
    const registry = await registryClient(pkg);
    const fetchManifest = async (digest) => {
        if (!manifests.has(digest)) manifests.set(digest, await registry.manifest(digest));
        return manifests.get(digest);
    };

    const keep = new Map(); // digest → reason
    for (const v of versions) {
        const real = v.metadata.container.tags.filter((t) => !POINTER_TAG.test(t));
        if (real.length > 0) keep.set(v.name, `tagged ${real.join(",")}`);
        else if (Date.parse(v.created_at) > cutoff) keep.set(v.name, `younger than ${keepDays}d`);
    }

    // Close over references until nothing new is reachable. Each round can
    // only add, and the graph is a few dozen nodes, so this is cheap.
    const expanded = new Set();
    for (;;) {
        const before = keep.size;
        for (const digest of [...keep.keys()]) {
            if (expanded.has(digest)) continue;
            expanded.add(digest);
            const m = await fetchManifest(digest);
            for (const child of m?.manifests ?? []) {
                if (byDigest.has(child.digest) && !keep.has(child.digest)) {
                    keep.set(child.digest, `listed by ${short(digest)}`);
                }
            }
        }
        for (const v of versions) {
            if (keep.has(v.name)) continue;
            const pointer = v.metadata.container.tags.map((t) => t.match(POINTER_TAG)).find(Boolean);
            if (pointer && keep.has(`sha256:${pointer[1]}`)) {
                keep.set(v.name, `${pointer[2] ?? "referrers"} of ${pointer[1].slice(0, 12)}`);
                continue;
            }
            const m = await fetchManifest(v.name);
            if (m?.subject?.digest && keep.has(m.subject.digest)) {
                keep.set(v.name, `subject ${short(m.subject.digest)}`);
            }
        }
        if (keep.size === before) break;
    }

    // Report, oldest first; then delete parents before the children they
    // list, so a registry that checks references never sees a dangling index.
    const sorted = [...versions].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const prune = [];
    for (const v of sorted) {
        const tags = v.metadata.container.tags.map(shortTag).join(",") || "-";
        const reason = keep.get(v.name);
        console.log(`   ${reason ? "keep " : "prune"} ${short(v.name)}  ${v.created_at.slice(0, 10)}  ${tags.padEnd(24)} ${reason ?? "unreachable"}`);
        if (!reason) prune.push(v);
    }
    prune.sort((a, b) => (manifests.get(b.name)?.manifests?.length ?? 0) - (manifests.get(a.name)?.manifests?.length ?? 0));

    console.log(`   ${keep.size} kept, ${prune.length} to prune`);
    if (!opts.delete) continue;
    for (const v of prune) {
        const res = await fetch(`${api}/${pkg}/versions/${v.id}`, { method: "DELETE", headers: apiHeaders });
        if (res.status === 204) {
            deleted++;
            continue;
        }
        failed++;
        console.error(`   failed to delete ${short(v.name)} (id ${v.id}): HTTP ${res.status} ${(await res.text()).trim()}`);
        if (res.status === 403) {
            console.error(`   A 403 here usually means the package does not grant this repository the admin role: Packages → ${pkg} → Package settings → Manage Actions access.`);
        }
    }
}

console.log(`\n${opts.delete ? `${deleted} deleted, ${failed} failed` : "dry run: nothing deleted (pass --delete)"}`);
process.exit(failed > 0 ? 1 : 0);

async function listVersions(pkg) {
    const all = [];
    for (let page = 1; ; page++) {
        const res = await fetch(`${api}/${pkg}/versions?state=active&per_page=100&page=${page}`, { headers: apiHeaders });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`listing ${pkg} versions: HTTP ${res.status} ${(await res.text()).trim()}`);
        const batch = await res.json();
        all.push(...batch);
        if (batch.length < 100) return all;
    }
}

// The registry speaks the distribution API, not the GitHub one, and wants
// its own bearer token. GHCR hands one out against GITHUB_TOKEN as the
// password, which also covers a package that is private.
async function registryClient(pkg) {
    const repo = `${opts.owner}/${pkg}`.toLowerCase();
    const res = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`, {
        headers: { Authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
    });
    if (!res.ok) throw new Error(`registry token for ${repo}: HTTP ${res.status}`);
    const bearer = (await res.json()).token;
    return {
        async manifest(digest) {
            const r = await fetch(`https://ghcr.io/v2/${repo}/manifests/${digest}`, {
                headers: { Authorization: `Bearer ${bearer}`, Accept: MANIFEST_ACCEPT },
            });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error(`manifest ${repo}@${digest}: HTTP ${r.status}`);
            return r.json();
        },
    };
}

function short(digest) {
    return digest.replace(/^sha256:/, "").slice(0, 12);
}

function shortTag(tag) {
    const m = tag.match(POINTER_TAG);
    return m ? `sha256-${m[1].slice(0, 12)}…${m[2] ?? ""}` : tag;
}
