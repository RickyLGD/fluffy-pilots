// Runs SQL (HogQL) against the game's PostHog project, read only.
// Needs POSTHOG_PERSONAL_API_KEY (a personal key with the "query:read" scope) and POSTHOG_PROJECT_ID.
const host = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "");

export async function query(sql) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const project = process.env.POSTHOG_PROJECT_ID;
  if (!key || !project) throw new Error("POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is not set");

  const response = await fetch(`${host}/api/projects/${project}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql }, name: "weekly-report" }),
  });
  if (!response.ok) {
    throw new Error(`PostHog answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  // Turn [columns] + [[row values]] into a list of objects.
  return (data.results || []).map((row) => Object.fromEntries(data.columns.map((name, i) => [name, row[i]])));
}
