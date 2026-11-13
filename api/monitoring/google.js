/**
 * The pod's Google access for the monitoring page and its monitoring report: project and token from
 * the GKE metadata server, shared by requests that run at the same time, and BigQuery queries.
 */
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
/** Private Google Access in the cluster serves *.googleapis.com, not the regional rep names. */
const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';

class QueryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** `fetchFn` is swapped in tests; `dataset` names the feedback store. */
function createGoogle({ fetchFn = fetch, dataset }) {
  let project = '';
  let token = { value: '', expires: 0 };
  let refreshing = null;

  async function metadata(p) {
    const res = await fetchFn(`${METADATA}/${p}`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) {
      throw new QueryError(502, `metadata HTTP ${res.status}`);
    }
    return res;
  }

  async function refresh() {
    if (!project) {
      project = (await (await metadata('project/project-id')).text()).trim();
    }
    const data = await (await metadata('instance/service-accounts/default/token')).json();
    token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  }

  /** Queries run in parallel, so they share one token request. */
  async function credentials() {
    if (!project || Date.now() > token.expires - 60000) {
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
    }
    return { project, token: token.value };
  }

  async function call(url, body) {
    const { token: bearer } = await credentials();
    const res = await fetchFn(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      return res.json();
    }
    const detail = await res.text();
    // DML cannot touch a row while it is in the streaming buffer, about six minutes after it arrives.
    if (detail.includes('streaming buffer')) {
      throw new QueryError(409, 'streaming buffer');
    }
    throw new QueryError(502, `BigQuery HTTP ${res.status}`);
  }

  /** Rows as arrays of strings, and the number of rows a DML statement changed. */
  async function query(sql, params) {
    const { project: id } = await credentials();
    const base = `${BIGQUERY}/projects/${id}/queries`;
    let data = await call(base, {
      query: sql,
      useLegacySql: false,
      // Small queries then run without a job: about 0.3 s instead of 1 s each in sov-dev.
      jobCreationMode: 'JOB_CREATION_OPTIONAL',
      timeoutMs: 60000,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(params).map(([name, { type, value }]) => ({
        name,
        parameterType: { type },
        parameterValue: { value },
      })),
    });
    if (!data.jobComplete) {
      throw new QueryError(504, 'query did not finish in time');
    }
    const rows = (data.rows || []).map((row) => row.f.map((cell) => cell.v));
    const { jobId, location } = data.jobReference || {};
    while (data.pageToken) {
      const page = new URLSearchParams({ location, pageToken: data.pageToken });
      data = await call(`${base}/${jobId}?${page}`);
      rows.push(...(data.rows || []).map((row) => row.f.map((cell) => cell.v)));
    }
    return { rows, changed: Number(data.numDmlAffectedRows || 0) };
  }

  const table = async (name) => `\`${(await credentials()).project}.${dataset}.${name}\``;

  return { credentials, query, table };
}

module.exports = { createGoogle, QueryError };
