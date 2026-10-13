import { useEffect, useId, useState } from "react";

type Mermaid = typeof import("mermaid").default;

// Mermaid is large, so it loads with the first diagram and not with the app.
let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    // "strict" keeps diagram text as text: no HTML in labels, no click handlers.
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    return mermaid;
  });
  return mermaidPromise;
}

/**
 * Renders a ```mermaid block as a diagram. The source is shown as code until
 * it parses, which also covers a diagram that is still streaming into the chat
 * and one the model wrote with a syntax error.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    (async () => {
      const mermaid = await loadMermaid();
      const valid = await mermaid.parse(code, { suppressErrors: true });
      const rendered = valid ? (await mermaid.render(id, code)).svg : null;
      if (!stale) setSvg(rendered);
    })().catch(() => {
      if (!stale) setSvg(null);
    });
    return () => {
      stale = true;
    };
  }, [code, id]);

  if (svg === null) {
    return (
      <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 my-3 overflow-x-auto">
        <code className="text-sm text-zinc-200">{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="mermaid-diagram my-3 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
