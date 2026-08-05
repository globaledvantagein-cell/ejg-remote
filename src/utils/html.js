// Copied verbatim (behaviour-for-behaviour) from job-Data/src/utils/htmlUtils.js.
// Kept identical so remote jobs render exactly like German-pipeline jobs on the
// frontend — any drift here would show up as inconsistent job descriptions.
import he from 'he';
import { JSDOM } from 'jsdom';

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function StripHtml(html) {
    if (!html) return "";
    // Decode first (handles double-encoded &lt;p&gt; → <p>), then strip tags
    const decoded = he.decode(html);
    const stripped = decoded.replace(/<[^>]+>/g, "");
    const clean = he.decode(stripped).replace(/\s+/g, " ").trim();
    return clean;
}

// Tags whose opening + closing tags are kept (all attributes stripped)
const SANITIZE_KEEP = new Set([
    'p', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'b', 'i', 'br',
]);

// Tags removed entirely (element + all children)
const SANITIZE_REMOVE_TREE = new Set([
    'script', 'style', 'svg', 'img', 'picture', 'video', 'audio',
    'iframe', 'noscript', 'figure', 'figcaption', 'form', 'input',
    'button', 'select', 'textarea',
]);

/**
 * Detects if content is double-encoded HTML (e.g. &lt;p&gt; instead of <p>).
 * Some ATS APIs (Greenhouse for certain companies) return HTML-encoded content.
 */
function decodeIfNeeded(html) {
    if (!html) return html;
    // If the string contains &lt; followed by a tag-like pattern, it's double-encoded
    if (/&lt;\s*\/?[a-z]/i.test(html)) {
        return he.decode(html);
    }
    return html;
}

/**
 * Strips unsafe / presentational HTML while keeping structural tags.
 * Returns clean HTML suitable for frontend rendering via dangerouslySetInnerHTML.
 *
 * Keeps : <p> <ul> <ol> <li> <h1>–<h6> <strong> <em> <b> <i> <br>
 * Removes entirely: <script> <style> <img> <svg> <iframe> and similar
 * Unwraps (keeps children): everything else – <div> <span> <table> <a> etc.
 * All attributes are stripped from kept tags.
 *
 * @param {string} html - Raw HTML string from an ATS API
 * @returns {string} Sanitized HTML string
 */
export function SanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';

    // Decode double-encoded HTML before JSDOM sees it
    const decoded = decodeIfNeeded(html);

    const dom = new JSDOM(`<!DOCTYPE html><html><body>${decoded}</body></html>`);
    const doc = dom.window.document;

    // ── Phase 0: Remove ATS boilerplate sections ──────────────────────
    // Greenhouse wraps company blurbs in div.content-intro and legal
    // disclaimers in div.content-conclusion. Neither is part of the JD.
    doc.querySelectorAll('.content-intro, .content-conclusion').forEach(el => el.remove());

    // Remove whole subtrees first (faster than per-node checks)
    SANITIZE_REMOVE_TREE.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => el.remove());
    });

    // Recursively walk the body, keeping/stripping/unwrapping as needed.
    // We snapshot childNodes with Array.from() before every iteration to avoid
    // live-NodeList issues when nodes are moved or removed mid-walk.
    function walk(node) {
        if (node.nodeType === 3 /* TEXT_NODE */) return; // keep text as-is
        if (node.nodeType !== 1 /* ELEMENT_NODE */) {
            node.parentNode?.removeChild(node);
            return;
        }

        const tag = node.tagName.toLowerCase();

        if (SANITIZE_REMOVE_TREE.has(tag)) {
            node.parentNode?.removeChild(node);
            return;
        }

        // Walk children first (depth-first) before deciding what to do with this node
        Array.from(node.childNodes).forEach(walk);

        if (SANITIZE_KEEP.has(tag)) {
            // Strip every attribute — no class, style, id, data-*, etc.
            Array.from(node.attributes).forEach(attr => node.removeAttribute(attr.name));
        } else {
            // Unwrap: move children before this node, then remove the tag
            const parent = node.parentNode;
            if (parent) {
                Array.from(node.childNodes).forEach(child => parent.insertBefore(child, node));
                parent.removeChild(node);
            }
        }
    }

    Array.from(doc.body.childNodes).forEach(walk);

    // ── Phase 2: Wrap orphaned text/inline nodes in <p> ──────────────
    // After div-unwrapping, bare text nodes and inline elements (strong, em, br)
    // can end up as direct children of <body> with no block-level wrapper.
    // Group consecutive non-block siblings into <p> tags for proper spacing.
    const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const body = doc.body;
    const children = Array.from(body.childNodes);
    let run = [];

    function flushRun() {
        if (run.length === 0) return;
        // Only wrap if the run has visible text content
        const text = run.map(n => n.textContent || '').join('').trim();
        if (text.length > 0) {
            const p = doc.createElement('p');
            run[0].parentNode.insertBefore(p, run[0]);
            run.forEach(n => p.appendChild(n));
        }
        run = [];
    }

    for (const child of children) {
        const isBlock = child.nodeType === 1 && BLOCK_TAGS.has(child.tagName.toLowerCase());
        if (isBlock) {
            flushRun();
        } else {
            run.push(child);
        }
    }
    flushRun();

    // Collapse runs of 3+ <br> tags that ATS systems sometimes produce
    let result = doc.body.innerHTML;
    result = result.replace(/(<br\s*\/?>\s*){3,}/gi, '<br>');

    // Remove empty paragraphs (leftover from unwrapping empty divs, or nbsp-only)
    result = result.replace(/<p>\s*(<br\s*\/?>|\s|&nbsp;)*\s*<\/p>/gi, '');

    return result.trim();
}
