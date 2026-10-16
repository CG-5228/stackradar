#!/usr/bin/env node
/**
 * README figures.
 *
 * Writes the SVG illustrations under docs/images/ that the README's
 * "How it works" section embeds: the system topology (who talks to whom,
 * over which boundary) and the life of one image (discover, SBOM, match,
 * score, fix, and where each step runs). Each comes in a light and a dark
 * variant so a <picture> element can follow the viewer's GitHub theme.
 *
 * The colours are the Primer primitives that `client/src/app/theme.css` is
 * generated from, so the figures sit next to the dashboard screenshot
 * without a seam. The fonts are the system stack GitHub renders markdown
 * with: an SVG inside an <img> loads no web fonts, so every text box below
 * leaves slack for the widest common rendering.
 *
 * No dependencies; runs on bare node from a bare checkout:
 *
 *   node scripts/readme-figures.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "images");

// ---------------------------------------------------------------------------
// Palette: Primer light / dark primitives (see client/src/app/theme.css).
// ---------------------------------------------------------------------------

const THEMES = {
    light: {
        canvas: "#ffffff",
        subtle: "#f6f8fa",
        border: "#d1d9e0",
        fg: "#1f2328",
        muted: "#59636e",
        faint: "#818b98",
        accent: "#0969da",
        accentSubtle: "#ddf4ff",
        onAccent: "#ffffff",
        critical: "#d1242f",
        high: "#bc4c00",
        medium: "#9a6700",
        low: "#59636e",
    },
    dark: {
        canvas: "#0d1117",
        subtle: "#161b22",
        border: "#3d444d",
        fg: "#f0f6fc",
        muted: "#9198a1",
        faint: "#656c76",
        accent: "#4493f8",
        accentSubtle: "rgba(56, 139, 253, 0.15)",
        onAccent: "#ffffff",
        critical: "#f85149",
        high: "#db6d28",
        medium: "#d29922",
        low: "#9198a1",
    },
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;

// ---------------------------------------------------------------------------
// Primitives. Every helper returns an SVG fragment as a string.
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rough advance width of a string, used only to size pills and chips. */
const measure = (s, size, mono = false) => s.length * size * (mono ? 0.62 : 0.56);

function text(x, y, s, o = {}) {
    const { size = 12, weight = 400, fill, anchor = "start", mono = false } = o;
    const family = mono ? MONO : FONT;
    return `<text x="${x}" y="${y}" font-family='${family}' font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

function rect(x, y, w, h, o = {}) {
    const { rx = 8, fill = "none", stroke = "none", sw = 1, dash = "" } = o;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function line(d, o = {}) {
    const { stroke, sw = 1.5, dash = "", marker = "" } = o;
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${marker ? ` marker-end="url(#${marker})"` : ""}/>`;
}

/** One arrowhead marker per colour: SVG 1.1 markers do not inherit stroke. */
function marker(id, fill) {
    return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 Z" fill="${fill}"/></marker>`;
}

/** A label with its own background, so it can sit on top of a line. */
function pill(cx, cy, s, t, o = {}) {
    const { size = 10.5, mono = false, fill = t.canvas, stroke = t.border, color = t.muted } = o;
    const w = Math.ceil(measure(s, size, mono)) + 16;
    const h = 20;
    return (
        rect(cx - w / 2, cy - h / 2, w, h, { rx: 10, fill, stroke }) +
        text(cx, cy + size * 0.36, s, { size, fill: color, anchor: "middle", mono })
    );
}

/** A chip of sample data, left-aligned; returns [svg, width]. */
function chip(x, y, s, t, o = {}) {
    const { size = 9.5, mono = true } = o;
    const w = Math.ceil(measure(s, size, mono)) + 12;
    const h = 20;
    const svg =
        rect(x, y, w, h, { rx: 5, fill: t.subtle, stroke: t.border }) +
        text(x + w / 2, y + h / 2 + size * 0.36, s, { size, fill: t.muted, anchor: "middle", mono });
    return [svg, w];
}

/** A card: bordered box with a title and lines of muted body text. */
function card(x, y, w, h, t, o = {}) {
    const { title, lines = [], icon = "", titleSize = 13, lineSize = 11, pad = 14, titleX = 0 } = o;
    let s = rect(x, y, w, h, { fill: t.canvas, stroke: t.border });
    if (icon) s += icon;
    if (title) s += text(x + pad + titleX, y + pad + 12, title, { size: titleSize, weight: 600, fill: t.fg });
    lines.forEach((l, i) => {
        s += text(x + pad, y + pad + 32 + i * (lineSize + 4), l, { size: lineSize, fill: t.muted });
    });
    return s;
}

/** A group: subtle field with a label; cards sit inside it. */
function group(x, y, w, h, label, t, o = {}) {
    const { icon = "" } = o;
    return (
        rect(x, y, w, h, { rx: 12, fill: t.subtle, stroke: t.border }) +
        icon +
        text(x + 16 + (icon ? 22 : 0), y + 24, label, { size: 12, weight: 600, fill: t.muted })
    );
}

// ---------------------------------------------------------------------------
// Glyphs, each drawn in a 20×20 box whose top-left is (x, y).
// ---------------------------------------------------------------------------

const glyph = {
    ring: (x, y, c) => `<circle cx="${x + 10}" cy="${y + 10}" r="7" fill="none" stroke="${c}" stroke-width="4"/>`,
    browser: (x, y, c) =>
        rect(x + 1.5, y + 3, 17, 14, { rx: 2.5, stroke: c, sw: 1.5 }) +
        line(`M${x + 1.5} ${y + 7.5} H${x + 18.5}`, { stroke: c }) +
        `<circle cx="${x + 4.5}" cy="${y + 5.25}" r="0.9" fill="${c}"/><circle cx="${x + 7.5}" cy="${y + 5.25}" r="0.9" fill="${c}"/>`,
    cluster: (x, y, c) =>
        rect(x + 2, y + 3, 16, 6, { rx: 1.5, stroke: c, sw: 1.5 }) +
        rect(x + 2, y + 11, 16, 6, { rx: 1.5, stroke: c, sw: 1.5 }) +
        `<circle cx="${x + 5}" cy="${y + 6}" r="1" fill="${c}"/><circle cx="${x + 5}" cy="${y + 14}" r="1" fill="${c}"/>`,
    pods: (x, y, c) =>
        line(`M${x + 10} ${y + 2} L${x + 17} ${y + 6} V${y + 14} L${x + 10} ${y + 18} L${x + 3} ${y + 14} V${y + 6} Z M${x + 3} ${y + 6} L${x + 10} ${y + 10} L${x + 17} ${y + 6} M${x + 10} ${y + 10} V${y + 18}`, { stroke: c }),
    scan: (x, y, c) =>
        line(`M${x + 2} ${y + 7} V${y + 4} a2 2 0 0 1 2 -2 H${x + 7} M${x + 13} ${y + 2} H${x + 16} a2 2 0 0 1 2 2 V${y + 7} M${x + 18} ${y + 13} V${y + 16} a2 2 0 0 1 -2 2 H${x + 13} M${x + 7} ${y + 18} H${x + 4} a2 2 0 0 1 -2 -2 V${y + 13} M${x + 5} ${y + 10} H${x + 15}`, { stroke: c }),
    database: (x, y, c) =>
        `<ellipse cx="${x + 10}" cy="${y + 5}" rx="7" ry="3" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 3} ${y + 5} V${y + 15} a7 3 0 0 0 14 0 V${y + 5} M${x + 3} ${y + 10} a7 3 0 0 0 14 0`, { stroke: c }),
    globe: (x, y, c) =>
        `<circle cx="${x + 10}" cy="${y + 10}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 2.5} ${y + 10} H${x + 17.5} M${x + 10} ${y + 2.5} a11 11 0 0 1 0 15 M${x + 10} ${y + 2.5} a11 11 0 0 0 0 15`, { stroke: c, sw: 1.25 }),
    search: (x, y, c) =>
        `<circle cx="${x + 8.5}" cy="${y + 8.5}" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 12.5} ${y + 12.5} L${x + 17.5} ${y + 17.5}`, { stroke: c }),
    gauge: (x, y, c) =>
        line(`M${x + 3} ${y + 15} a7.5 7.5 0 0 1 14 0 M${x + 10} ${y + 14} L${x + 13.5} ${y + 8}`, { stroke: c }) +
        `<circle cx="${x + 10}" cy="${y + 14}" r="1.5" fill="${c}"/>`,
    upgrade: (x, y, c) =>
        `<circle cx="${x + 10}" cy="${y + 10}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 10} ${y + 14} V${y + 6} M${x + 6.5} ${y + 9.5} L${x + 10} ${y + 6} L${x + 13.5} ${y + 9.5}`, { stroke: c }),
};

function svg(w, h, t, body, label) {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">\n` +
        `<defs>${marker("arrow-muted", t.muted)}${marker("arrow-accent", t.accent)}${marker("arrow-faint", t.faint)}</defs>\n` +
        body +
        `\n</svg>\n`
    );
}

// ---------------------------------------------------------------------------
// Figure 1: the topology.
// ---------------------------------------------------------------------------

function topology(t) {
    const W = 960;
    const H = 468;
    const GY = 96;
    const GH = 348;
    let s = "";

    // --- Your cluster -------------------------------------------------------
    const cx = 24;
    const cw = 244;
    s += group(cx, GY, cw, GH, "Your Kubernetes cluster", t, { icon: glyph.cluster(cx + 14, GY + 12, t.muted) });

    const podsY = 132;
    s += card(cx + 16, podsY, 212, 86, t, {
        title: "Pods",
        lines: ["Every namespace, every container."],
        icon: glyph.pods(cx + 30, podsY + 14, t.muted),
        titleX: 26,
    });
    let chipX = cx + 30;
    for (const ns of ["ci", "argocd", "monitoring"]) {
        const [c, w] = chip(chipX, podsY + 54, ns, t);
        s += c;
        chipX += w + 6;
    }

    const scY = 254;
    s += line(`M${cx + 122} ${podsY + 86} V${scY - 2}`, { stroke: t.muted, marker: "arrow-muted" });
    s += pill(cx + 122, podsY + 86 + 18, "list, watch (read-only)", t);
    s += card(cx + 16, scY, 212, 100, t, {
        title: "stackradar-scanner",
        lines: ["Pod informer. Pulls each image", "once per digest and writes its", "CycloneDX SBOM with Syft."],
        icon: glyph.scan(cx + 30, scY + 14, t.accent),
        titleX: 26,
    });
    s += text(cx + 16, scY + 100 + 30, "No create, update, delete or patch", { size: 10.5, fill: t.faint });
    s += text(cx + 16, scY + 100 + 45, "on anything. No telemetry.", { size: 10.5, fill: t.faint });

    // --- StackRadar ---------------------------------------------------------
    const px = 372;
    const pw = 280;
    const kx = px + 16;
    const kw = pw - 32;
    s += group(px, GY, pw, GH, "StackRadar", t, { icon: glyph.ring(px + 14, GY + 12, t.accent) });

    const clY = 136;
    s += card(kx, clY, kw, 74, t, {
        title: "client",
        lines: ["Next.js UI and BFF. Owns sign-in;", "the only thing a browser talks to."],
        icon: glyph.browser(kx + 14, clY + 14, t.muted),
        titleX: 26,
    });

    const svY = 260;
    s += card(kx, svY, kw, 88, t, {
        title: "server",
        lines: ["API, job worker, sync schedule.", "Matches every SBOM against the", "mirror and ranks every finding."],
        icon: glyph.ring(kx + 14, svY + 14, t.accent),
        titleX: 26,
    });

    const pgY = 380;
    s += card(kx, pgY, kw, 48, t, {
        title: "PostgreSQL",
        icon: glyph.database(kx + 14, pgY + 14, t.muted),
        titleX: 26,
    });
    s += text(kx + kw - 14, pgY + 26 + 4, "one database", { size: 11, fill: t.muted, anchor: "end" });

    // client → server, server → postgres
    s += line(`M${px + pw / 2} ${clY + 74} V${svY - 2}`, { stroke: t.muted, marker: "arrow-muted" });
    s += pill(px + pw / 2, clY + 74 + 24, "internal service key", t);
    s += line(`M${px + pw / 2} ${svY + 88} V${pgY - 2}`, { stroke: t.muted, marker: "arrow-muted" });

    // --- Browser ------------------------------------------------------------
    const bw = 150;
    const bx = px + (pw - bw) / 2;
    const by = 16;
    s += card(bx, by, bw, 44, t, { title: "Browser", icon: glyph.browser(bx + 14, by + 12, t.muted), titleX: 26 });
    s += line(`M${px + pw / 2} ${by + 44} V${clY - 2}`, { stroke: t.muted, marker: "arrow-muted" });
    s += pill(px + pw / 2, by + 44 + 22, "session", t);

    // --- Scanner → server: the one write path into the platform -------------
    const sy = svY + 44;
    s += line(`M${cx + 228} ${sy} H${kx - 2}`, { stroke: t.accent, sw: 2, marker: "arrow-accent" });
    const mid = (cx + 228 + kx) / 2;
    s += pill(mid, sy - 14, "SBOM + inventory", t, { color: t.accent, fill: t.accentSubtle, stroke: "none" });
    s += pill(mid, sy + 14, "cluster-scoped API key", t, { size: 10 });

    // --- Advisory feeds -----------------------------------------------------
    const fx = 764;
    const fw = 172;
    s += group(fx, GY, fw, GH, "Advisory feeds", t, { icon: glyph.globe(fx + 14, GY + 12, t.muted) });
    const feeds = [
        ["OSV.dev", "hourly"],
        ["EPSS", "daily"],
        ["CISA KEV", "daily"],
    ];
    s += text(fx + 16, GY + 52, "Fetched by the server on a", { size: 10.5, fill: t.faint });
    s += text(fx + 16, GY + 67, "schedule. Nothing is sent", { size: 10.5, fill: t.faint });
    s += text(fx + 16, GY + 82, "anywhere to be scored.", { size: 10.5, fill: t.faint });
    const busX = fx + 22;
    const feedX = fx + 38;
    const feedW = fw - 54;
    const feedYs = [230, 282, 334];
    feeds.forEach(([name, cadence], i) => {
        const y = feedYs[i];
        s += rect(feedX, y, feedW, 44, { fill: t.canvas, stroke: t.border });
        s += text(feedX + 12, y + 19, name, { size: 12, weight: 600, fill: t.fg });
        s += text(feedX + 12, y + 35, cadence, { size: 10.5, fill: t.muted });
        s += line(`M${feedX} ${y + 22} H${busX}`, { stroke: t.faint, dash: "3 3" });
    });
    s += line(`M${busX} ${feedYs[0] + 22} V${feedYs[2] + 22}`, { stroke: t.faint, dash: "3 3" });
    s += line(`M${busX} ${sy} H${kx + kw + 2}`, { stroke: t.faint, dash: "3 3", marker: "arrow-faint" });
    s += pill((busX + kx + kw) / 2, sy - 14, "mirrored locally", t);

    return svg(
        W,
        H,
        t,
        s,
        "StackRadar topology: a read-only scanner in your cluster sends SBOMs and inventory to the server over a cluster-scoped key; the server mirrors OSV.dev, EPSS and CISA KEV locally and stores everything in one PostgreSQL; the browser reaches the client only.",
    );
}

// ---------------------------------------------------------------------------
// Figure 2: the life of one image.
// ---------------------------------------------------------------------------

function pipeline(t) {
    const W = 960;
    const H = 246;
    const X0 = 12;
    const CW = 168;
    const GAP = 24;
    const CY = 20;
    const CH = 164;
    let s = "";

    const sevBar = (x, y) => {
        const parts = [
            [24, t.critical],
            [50, t.high],
            [46, t.medium],
            [24, t.low],
        ];
        let out = `<clipPath id="sev"><rect x="${x}" y="${y}" width="144" height="10" rx="5"/></clipPath><g clip-path="url(#sev)">`;
        let cx = x;
        for (const [w, c] of parts) {
            out += `<rect x="${cx}" y="${y}" width="${w - 2}" height="10" fill="${c}"/>`;
            cx += w;
        }
        return out + "</g>";
    };

    const steps = [
        {
            title: "Discover",
            icon: glyph.scan,
            lines: ["The agent watches every", "pod in the cluster. Read-", "only: list and watch,", "nothing else."],
            footer: (x, y) => {
                let out = "";
                let cx = x;
                for (const ns of ["ci", "argocd", "grafana"]) {
                    const [c, w] = chip(cx, y, ns, t);
                    out += c;
                    cx += w + 6;
                }
                return out;
            },
        },
        {
            title: "SBOM",
            icon: glyph.pods,
            lines: ["Pulled once per digest.", "Syft writes a CycloneDX", "SBOM; the inventory says", "where the image runs."],
            footer: (x, y) => chip(x, y, "pkg:npm/express@4.19.2", t)[0],
        },
        {
            title: "Match",
            icon: glyph.search,
            lines: ["Each package URL is", "looked up in the local", "OSV.dev mirror, and again", "whenever it changes."],
            footer: (x, y) => chip(x, y, "CVE-2025-1974", t)[0],
        },
        {
            title: "Score",
            icon: glyph.gauge,
            lines: ["CVSS, EPSS and KEV fold", "into one number per", "finding; sums rank images,", "containers and clusters."],
            footer: (x, y) => sevBar(x, y + 5),
        },
        {
            title: "Fix",
            icon: glyph.upgrade,
            lines: ["The tag or chart version", "to move to, what that", "removes, and the command", "that does it."],
            footer: (x, y) => chip(x, y, "argocd app sync jenkins", t)[0],
        },
    ];

    steps.forEach((step, i) => {
        const x = X0 + i * (CW + GAP);
        s += rect(x, CY, CW, CH, { fill: t.canvas, stroke: t.border });
        // number badge
        s += `<circle cx="${x + 25}" cy="${CY + 25}" r="11" fill="${t.accent}"/>`;
        s += text(x + 25, CY + 29, String(i + 1), { size: 11, weight: 600, fill: t.onAccent, anchor: "middle" });
        s += text(x + 44, CY + 29.5, step.title, { size: 13, weight: 600, fill: t.fg });
        s += step.icon(x + CW - 34, CY + 15, t.faint);
        step.lines.forEach((l, j) => {
            s += text(x + 14, CY + 58 + j * 15, l, { size: 10.5, fill: t.muted });
        });
        s += step.footer(x + 14, CY + 126);
        if (i < steps.length - 1) {
            s += line(`M${x + CW + 4} ${CY + 25} H${x + CW + GAP - 6}`, { stroke: t.muted, marker: "arrow-muted" });
        }
    });

    // Where each step runs.
    const bracket = (x1, x2, label) => {
        const y = CY + CH + 22;
        return (
            line(`M${x1} ${y - 6} V${y} H${x2} V${y - 6}`, { stroke: t.border, sw: 1 }) +
            text((x1 + x2) / 2, y + 20, label, { size: 11, weight: 600, fill: t.muted, anchor: "middle" })
        );
    };
    s += bracket(X0, X0 + 2 * CW + GAP, "In your cluster · stackradar-scanner");
    s += bracket(X0 + 2 * (CW + GAP), X0 + 5 * CW + 4 * GAP, "On the server · this repository");

    return svg(
        W,
        H,
        t,
        s,
        "The life of one image: discovered by the read-only agent, inventoried and turned into a CycloneDX SBOM once per digest in your cluster; then matched against the local OSV.dev mirror, scored with CVSS, EPSS and KEV, and given a concrete fix on the server.",
    );
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
    writeFileSync(join(OUT, `how-it-works-${name}.svg`), topology(t));
    writeFileSync(join(OUT, `one-image-${name}.svg`), pipeline(t));
}
console.log(`wrote 4 figures to ${OUT}`);
