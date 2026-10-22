// The Database plugin's places for connections: Control › Databases (DatabasesPage: the global ones, and the chosen
// project's own) and a project's Databases in Connections (DatabasesSection: what that project uses, while the plugin is
// on for it). Both are DbManager: a grouped list with each database's logo and environment, and the editor. A local or
// test database may get changes of data (always after an OK); staging and prod are read only for agents, always.
// The Database plugin's part (plugins/db): it imports only react and @keel/web-sdk.

import { PageHead, Section, useApp, useLoad } from "@keel/web-sdk";
import { dbApi } from "./dbApi";
import { DbManager } from "./DbManager";

export function DatabasesSection({ pid }: { pid: string }) {
  const { project } = useApp();
  const plugins = useLoad(pid ? `plugins:${pid}` : null, () => dbApi.plugins(pid), { live: false });
  const on = !!plugins.data?.find((p) => p.name === "db")?.enabled;
  if (!on) return null;
  return (
    <Section title="Databases"
      sub="The databases this project uses: its own, and the ones for all projects (Control › Databases). For KeelBot, workflows and Map › Query.">
      <DbManager pid={pid} projectName={project?.name ?? pid} place="project" />
    </Section>
  );
}

export function DatabasesPage({ pid }: { pid: string }) {
  const { project } = useApp();
  return (
    <>
      <PageHead title="Databases"
        sub="Database connections for all projects, or for one. keel keeps each password encrypted; agents never see it." />
      <DbManager pid={pid} projectName={pid ? project?.name ?? pid : undefined} place="control" />
    </>
  );
}
