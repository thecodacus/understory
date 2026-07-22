import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Async Shiki highlighter using the JavaScript regex engine (no WASM).
// Per Shiki best practices: use createHighlighterCore + JavaScript engine
// for web apps to avoid WASM loading issues and reduce bundle size.
// Fine-grained imports keep bundle size minimal.
const highlighterPromise = createHighlighterCore({
  themes: [import("@shikijs/themes/github-dark-dimmed")],
  langs: [
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/jsx"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/shell"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/sql"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/go"),
    import("@shikijs/langs/java"),
    import("@shikijs/langs/csharp"),
    import("@shikijs/langs/php"),
    import("@shikijs/langs/ruby"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/xml"),
    import("@shikijs/langs/dockerfile"),
    import("@shikijs/langs/graphql"),
  ],
  engine: createJavaScriptRegexEngine(),
});

/** Sanitize schema: allow everything in defaultSchema plus tables. */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames || []), "table", "thead", "tbody", "tr", "th", "td"])],
  attributes: {
    ...(defaultSchema.attributes || {}),
    table: [...(defaultSchema.attributes?.table || []), "className"],
    thead: [...(defaultSchema.attributes?.thead || []), "className"],
    tbody: [...(defaultSchema.attributes?.tbody || []), "className"],
    tr: [...(defaultSchema.attributes?.tr || []), "className"],
    th: [...(defaultSchema.attributes?.th || []), "className"],
    td: [...(defaultSchema.attributes?.td || []), "className"],
  },
  // Allow alignment attributes on th/td for GFM table alignment
  protocols: {
    ...(defaultSchema.protocols || {}),
    href: [["http", "https", "mailto"]],
  },
};

export interface MarkdownRendererProps {
  children: string;
  className?: string;
  /** Resolve an href to a navigation target. Return null for external links. */
  onNavigate?: (href: string) => string | null;
  /** Called when an in-app link is clicked with the resolved path. */
  onNavigateClick?: (path: string) => void;
}

/**
 * Shared markdown renderer with:
 * - GFM (tables, strikethrough, task lists) via remark-gfm
 * - XSS sanitization via rehype-sanitize
 * - Syntax highlighting via Shiki (used directly in code component, NOT rehypeShiki)
 * - Custom table styling
 *
 * Uses createHighlighterCore with the JavaScript regex engine (no WASM)
 * per Shiki best practices for web applications.
 */
export function MarkdownRenderer({ children, className, onNavigate, onNavigateClick }: MarkdownRendererProps) {
  const [highlighter, setHighlighter] = useState<Awaited<typeof highlighterPromise> | null>(null);

  useEffect(() => {
    highlighterPromise.then(setHighlighter);
  }, []);

  const highlightCode = (code: string, language: string): string => {
    if (!highlighter) return code;
    try {
      const langs = highlighter.getLoadedLanguages();
      if (langs.includes(language as any)) {
        const highlighted = highlighter.codeToHtml(code, {
          lang: language,
          theme: "github-dark-dimmed",
        });
        return highlighted;
      }
    } catch {
      // Fall back to unhighlighted code
    }
    return `<pre class="shiki shiki-themes github-dark-dimmed code-block" tabindex="0"><code>${escapeHtml(code)}</code></pre>`;
  };

  const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };

  const components: Parameters<typeof ReactMarkdown>[0]["components"] = {
    a: ({ href, children: nodeChildren }) => {
      if (href && onNavigate) {
        const resolved = onNavigate(href);
        if (resolved !== null) {
          return (
            <a
              href={resolved}
              onClick={(e) => {
                e.preventDefault();
                onNavigateClick?.(resolved);
              }}
              className="text-cyan-400 hover:underline"
            >
              {nodeChildren}
            </a>
          );
        }
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
          {nodeChildren}
        </a>
      );
    },
    table: ({ node, ...props }) => (
      <div className="overflow-x-auto my-4 rounded-lg border border-zinc-700">
        <table className="min-w-full border-collapse" {...props} />
      </div>
    ),
    thead: ({ node, ...props }) => (
      <thead className="bg-zinc-800" {...props}>
        {props.children}
      </thead>
    ),
    th: ({ node, ...props }) => (
      <th
        className="border border-zinc-700 px-3 py-2 text-left font-semibold text-zinc-200 bg-zinc-800/50"
        {...props}
      >
        {props.children}
      </th>
    ),
    td: ({ node, ...props }) => (
      <td className="border border-zinc-700 px-3 py-2 text-sm text-zinc-300" {...props}>
        {props.children}
      </td>
    ),
    code: ({ className, children: nodeChildren, ...props }) => {
      const match = /language-(\w+)/.exec(className || "");
      const language = match?.[1];
      const codeText = String(nodeChildren);

      if (language && highlighter) {
        // Block code — highlight with Shiki
        const highlighted = highlightCode(codeText, language);
        return <div dangerouslySetInnerHTML={{ __html: highlighted }} />;
      }

      // Inline code — no highlighting
      return (
        <code className="bg-zinc-800 px-1 py-0.5 rounded text-sm text-amber-300 font-mono" {...props}>
          {nodeChildren}
        </code>
      );
    },
    pre: ({ children }) => (
      <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 my-3 overflow-x-auto">{children}</pre>
    ),
  };

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema]]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
