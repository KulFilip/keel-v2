import type { ReactNode } from "react";

/** A panel with a named region (the tests and screen readers find it by its title). */
export function PanelSection({
  id,
  title,
  extra,
  children,
  body = true,
}: {
  id: string;
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  body?: boolean;
}) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
        {extra}
      </div>
      {body ? <div className="panel-body">{children}</div> : children}
    </section>
  );
}
