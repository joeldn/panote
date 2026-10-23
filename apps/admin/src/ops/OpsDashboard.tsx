import './ops-dashboard.css';

import {
  DEFAULT_OPS_RANGE,
  OPS_RANGES,
  type OpsHealth,
  type OpsMetrics,
  type OpsRange,
  type OpsSection,
  type OpsUsage,
} from '@internal/contracts';
import { Button } from '@internal/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useSession } from '../session.js';
import {
  backupTone,
  formatMs,
  formatNumber,
  formatPercent,
  formatPoint,
  formatSize,
  formatTime,
  formatUsage,
} from './format.js';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; metrics: OpsMetrics };

const RANGE_LABEL: Record<OpsRange, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days' };

/** /app/ops: every metric the platform and the app record, for the operator. */
export function OpsDashboard() {
  const { api } = useSession();
  const [range, setRange] = useState<OpsRange>(DEFAULT_OPS_RANGE);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    api.getOpsMetrics(range).then(
      (metrics) => live && setLoad({ status: 'ready', metrics }),
      () => live && setLoad({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [api, range, attempt]);

  return (
    <div className="opsd">
      <div className="opsd__bar">
        <div className="opsd__ranges" role="group" aria-label="Time range">
          {OPS_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`opsd__range${r === range ? ' opsd__range--on' : ''}`}
              aria-pressed={r === range}
              onClick={() => {
                setLoad({ status: 'loading' });
                setRange(r);
              }}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <span className="opsd__updated">
          {load.status === 'ready' && `Updated ${formatTime(load.metrics.to)} UTC`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="fa-solid fa-rotate-right"
          onClick={() => {
            setLoad({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      {load.status === 'loading' && (
        <p className="app-status" role="status">
          Loading metrics…
        </p>
      )}
      {load.status === 'error' && (
        <p className="opsd__off" role="alert">
          Couldn’t load the metrics. Try Refresh.
        </p>
      )}
      {load.status === 'ready' && <Metrics m={load.metrics} />}
    </div>
  );
}

function Metrics({ m }: { m: OpsMetrics }) {
  const step = m.range === '24h' ? 'hour' : 'day';
  return (
    <>
      <Panel title="Health" section={m.health}>
        {(h) => <Health h={h} />}
      </Panel>

      <Panel title="Viewers" section={m.product} note="Sampled by Analytics Engine">
        {(p) => (
          <>
            <Tiles>
              <Tile label="Tour views" value={formatNumber(p.views)} />
              <Tile label="Scenes opened" value={formatNumber(p.scenes)} />
              <Tile label="Hotspots opened" value={formatNumber(p.hotspots)} />
              <Tile
                label="Avg. time per visit"
                value={p.dwellAvgMs === null ? '—' : formatMs(p.dwellAvgMs)}
              />
            </Tiles>
            <Bars
              title="Tour views"
              series={p.series.map((d) => ({ t: d.t, v: d.views }))}
              step={step}
            />
            <Table
              caption="Most viewed tours"
              head={['Tour', 'Views']}
              rows={p.topTours.map((t) => [
                t.title ?? <span className="opsd__muted">{`${t.tourId} (not published)`}</span>,
                formatNumber(t.views),
              ])}
              empty="No views in this range."
            />
            {p.surfaces.length > 0 && (
              <p className="opsd__line">
                {p.surfaces
                  .map(
                    (s) =>
                      `${s.surface === 'embed' ? 'Embeds' : 'Tour page'}: ${formatNumber(s.views)}`,
                  )
                  .join(' · ')}
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel title="Workers" section={m.workers}>
        {(w) => {
          const requests = w.scripts.reduce((s, x) => s + x.requests, 0);
          const errors = w.scripts.reduce((s, x) => s + x.errors, 0);
          return (
            <>
              <Tiles>
                <Tile label="Requests" value={formatNumber(requests)} />
                <Tile
                  label="Errors"
                  value={formatNumber(errors)}
                  tone={errors > 0 ? 'bad' : 'ok'}
                />
                <Tile label="Error rate" value={formatPercent(errors, requests)} />
              </Tiles>
              <Bars
                title="Requests"
                series={w.series.map((d) => ({ t: d.t, v: d.requests }))}
                step={step}
              />
              <Bars
                title="Errors"
                tone="bad"
                series={w.series.map((d) => ({ t: d.t, v: d.errors }))}
                step={step}
              />
              <Table
                caption="By Worker"
                head={[
                  'Worker',
                  'Requests',
                  'Errors',
                  'CPU p50',
                  'CPU p99',
                  'Subrequests',
                  'Not success',
                ]}
                rows={w.scripts.map((s) => [
                  s.script,
                  formatNumber(s.requests),
                  `${formatNumber(s.errors)} (${formatPercent(s.errors, s.requests)})`,
                  s.cpuP50Ms === null ? '—' : formatMs(s.cpuP50Ms),
                  s.cpuP99Ms === null ? '—' : formatMs(s.cpuP99Ms),
                  formatNumber(s.subrequests),
                  Object.entries(s.byStatus)
                    .filter(([k]) => k !== 'success')
                    .map(([k, n]) => `${k} ${formatNumber(n)}`)
                    .join(', ') || '—',
                ])}
              />
            </>
          );
        }}
      </Panel>

      <Panel title="Storage" section={m.storage}>
        {(s) => (
          <Table
            caption="R2 buckets"
            head={['Bucket', 'Objects', 'Size', 'Class A ops', 'Class B ops', 'Busiest operations']}
            rows={s.buckets.map((b) => [
              b.bucket,
              b.objects === null ? '—' : formatNumber(b.objects),
              b.bytes === null ? '—' : formatSize(b.bytes),
              formatNumber(b.classA),
              formatNumber(b.classB),
              b.topActions.map((a) => `${a.action} ${formatNumber(a.requests)}`).join(', ') || '—',
            ])}
          />
        )}
      </Panel>

      <Panel title="Upload queue" section={m.queues}>
        {(q) => (
          <Table
            caption="Queues"
            head={[
              'Queue',
              'Avg. backlog',
              'Written',
              'Read',
              'Done',
              'To DLQ',
              'Avg. wait',
              'Avg. retries',
            ]}
            rows={q.queues.map((x) => [
              x.name ?? x.queueId,
              formatNumber(x.backlogAvg),
              formatNumber(x.writes),
              formatNumber(x.reads),
              formatNumber(x.acked),
              x.dlq > 0 ? <strong className="opsd__bad">{formatNumber(x.dlq)}</strong> : '0',
              x.lagMsAvg === null ? '—' : formatMs(x.lagMsAvg),
              x.retriesAvg === null ? '—' : x.retriesAvg.toFixed(1),
            ])}
            empty="No queue activity in this range."
          />
        )}
      </Panel>

      <Panel title="Tiler containers" section={m.containers} note="Whole account">
        {(c) => (
          <>
            <Tiles>
              <Tile label="CPU time" value={formatUsage(c.cpuSeconds, 'seconds')} />
              <Tile label="Instances" value={formatNumber(c.instances)} />
              <Tile
                label="Peak memory"
                value={c.maxMemoryBytes === null ? '—' : formatSize(c.maxMemoryBytes)}
              />
              <Tile
                label="Peak CPU (p95)"
                value={
                  c.cpuUtilizationP95 === null ? '—' : `${Math.round(c.cpuUtilizationP95 * 100)}%`
                }
              />
            </Tiles>
            <Bars
              title="CPU seconds"
              series={c.series.map((d) => ({ t: d.t, v: d.cpuSeconds }))}
              step={step}
            />
          </>
        )}
      </Panel>

      <Panel title="Durable Objects" section={m.durableObjects} note="Whole account">
        {(d) => (
          <Tiles>
            <Tile label="Requests" value={formatNumber(d.requests)} />
            <Tile
              label="Errors"
              value={formatNumber(d.errors)}
              tone={d.errors > 0 ? 'bad' : 'ok'}
            />
            <Tile label="Stored" value={d.storedBytes === null ? '—' : formatSize(d.storedBytes)} />
          </Tiles>
        )}
      </Panel>

      <Panel title="This month against the plan" section={m.usage}>
        {(u) => <Usage u={u} />}
      </Panel>
    </>
  );
}

function Panel<T>({
  title,
  section,
  note,
  children,
}: {
  title: string;
  section: OpsSection<T>;
  note?: string;
  children: (data: T) => ReactNode;
}) {
  const id = `opsd-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section className="opsd__panel" aria-labelledby={id}>
      <h2 id={id} className="opsd__title">
        {title}
        {note && <span className="opsd__note">{note}</span>}
      </h2>
      {section.status === 'ok' ? (
        children(section.data)
      ) : (
        <p className="opsd__off">
          <i className="fa-solid fa-circle-exclamation" aria-hidden="true" /> Unavailable:{' '}
          {section.reason}
        </p>
      )}
    </section>
  );
}

function Tiles({ children }: { children: ReactNode }) {
  return <div className="opsd__tiles">{children}</div>;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="opsd__tile">
      <p className="opsd__label">{label}</p>
      <p className={`opsd__value${tone === 'bad' ? ' opsd__bad' : ''}`}>{value}</p>
    </div>
  );
}

/** One series as columns, oldest first; each column's value is in its tooltip and for screen readers. */
function Bars({
  title,
  series,
  step,
  tone,
}: {
  title: string;
  series: { t: string; v: number }[];
  step: 'hour' | 'day';
  tone?: 'bad';
}) {
  const max = Math.max(0, ...series.map((d) => d.v));
  const first = series[0];
  const last = series[series.length - 1];
  return (
    <figure className="opsd__chart">
      <figcaption className="opsd__label">
        {title} per {step} <span className="opsd__muted">· peak {formatNumber(max)}</span>
      </figcaption>
      <ol className="opsd__bars" aria-label={`${title} per ${step}`}>
        {series.map((d) => {
          const text = `${formatPoint(d.t, step)}: ${formatNumber(d.v)}`;
          return (
            <li
              key={d.t}
              className={`opsd__col${tone === 'bad' ? ' opsd__col--bad' : ''}`}
              style={{
                height: max > 0 && d.v > 0 ? `${Math.max(2, (d.v / max) * 100)}%` : undefined,
              }}
              data-empty={d.v === 0 || undefined}
              title={text}
            >
              <span className="opsd__sr">{text}</span>
            </li>
          );
        })}
      </ol>
      {first && last && (
        <div className="opsd__axis" aria-hidden="true">
          <span>{formatPoint(first.t, step)}</span>
          <span>{formatPoint(last.t, step)}</span>
        </div>
      )}
    </figure>
  );
}

function Table({
  caption,
  head,
  rows,
  empty,
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  return (
    <div className="opsd__scroll">
      <table className="opsd__table">
        <caption className="opsd__label">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="opsd__muted">
                {empty ?? 'Nothing yet.'}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'none';
const TONE_ICON: Record<Tone, string> = {
  ok: 'fa-solid fa-circle-check',
  warn: 'fa-solid fa-triangle-exclamation',
  bad: 'fa-solid fa-circle-exclamation',
  none: 'fa-solid fa-minus',
};
const TONE_TEXT: Record<Tone, string> = {
  ok: 'OK',
  warn: 'Warning',
  bad: 'Failing',
  none: 'No data',
};

function StatusRow({ tone, label, children }: { tone: Tone; label: string; children: ReactNode }) {
  return (
    <li className={`opsd__status opsd__status--${tone}`}>
      <i className={TONE_ICON[tone]} aria-hidden="true" />
      <span className="opsd__status-label">
        {label} <span className="opsd__sr">{TONE_TEXT[tone]}</span>
      </span>
      <span className="opsd__status-detail">{children}</span>
    </li>
  );
}

function Health({ h }: { h: OpsHealth }) {
  const cron = h.dailyCron;
  const purge = h.cdnPurge;
  const count = (n: number, capped: boolean) => `${formatNumber(n)}${capped ? '+' : ''}`;
  return (
    <ul className="opsd__statuses">
      <StatusRow
        tone={h.announcedDown.length > 0 ? 'bad' : h.failing.length > 0 ? 'warn' : 'ok'}
        label="Health checks"
      >
        {h.failing.length === 0
          ? 'All passing'
          : h.failing.map((f) => `${f.check} (${f.failures}× in a row)`).join(', ')}
        {h.lastAlertAt && ` · last alert ${formatTime(h.lastAlertAt)} UTC`}
      </StatusRow>
      <StatusRow tone={!cron ? 'none' : cron.failed.length > 0 ? 'bad' : 'ok'} label="Daily cron">
        {!cron
          ? 'Not run yet'
          : `Ran ${formatTime(cron.lastRunAt)}${
              cron.failed.length > 0 ? `, failed: ${cron.failed.join(', ')}` : ', all tasks OK'
            }${cron.lastOkAt ? ` · last clean ${formatTime(cron.lastOkAt)}` : ''}`}
      </StatusRow>
      <StatusRow
        tone={!h.tileGc ? 'none' : h.tileGc.lastOkAt === h.tileGc.lastRunAt ? 'ok' : 'warn'}
        label="Tile sweep"
      >
        {!h.tileGc
          ? 'Not run yet'
          : `Ran ${formatTime(h.tileGc.lastRunAt)}${
              h.tileGc.lastOkAt ? ` · last clean ${formatTime(h.tileGc.lastOkAt)}` : ''
            }`}
      </StatusRow>
      <StatusRow
        tone={purge.dead > 0 ? 'bad' : purge.pending > 0 ? 'warn' : 'ok'}
        label="CDN purge"
      >
        {`${count(purge.pending, purge.pendingCapped)} queued, ${count(purge.dead, purge.deadCapped)} dead letters`}
        {purge.lastFailure &&
          ` · last failure ${formatTime(purge.lastFailure.at)} (${purge.lastFailure.detail})`}
      </StatusRow>
      <StatusRow tone={backupTone(h.backup.lastCompleteDaysAgo)} label="Backup">
        {h.backup.lastCompleteDate
          ? `Last complete set ${h.backup.lastCompleteDate}`
          : 'No complete set yet'}
        {h.backup.inProgress &&
          ` · ${h.backup.inProgress.date} being written (${formatNumber(h.backup.inProgress.objects)} objects so far)`}
      </StatusRow>
    </ul>
  );
}

function Usage({ u }: { u: OpsUsage }) {
  return (
    <>
      <ul className="opsd__meters">
        {u.items.map((i) => {
          const share = i.used === null ? null : Math.min(1, i.used / i.included);
          return (
            <li key={i.key} className="opsd__meter">
              <span className="opsd__meter-label">{i.label}</span>
              <span className="opsd__meter-value">
                {i.used === null
                  ? `Unavailable: ${i.reason ?? 'unknown'}`
                  : `${formatUsage(i.used, i.unit)} of ${formatUsage(i.included, i.unit)}`}
              </span>
              {share !== null && (
                <span className="opsd__meter-bar" aria-hidden="true">
                  <span
                    className={`opsd__meter-fill${share >= 0.8 ? ' opsd__meter-fill--high' : ''}`}
                    style={{ width: `${share * 100}%` }}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="opsd__line opsd__muted">
        {u.month}, so far. Against what Workers Paid includes each month. Usage counts the whole
        account, dev included, except storage, which is this environment’s bucket.
      </p>
    </>
  );
}
