<script lang="ts">
  type Lane = { name:string; state:string; risk:string; why:string; finding:string; next:string; source:string };
  type Worker = { name:string; status:string; session:number; max_sessions:number; question?:string; controllerAlive?:boolean; currentActivity?:string };
  type GitRepo = { path:string; branch:string; head:string; dirty:number; staged:number; unstaged:number; untracked:number; ahead:number; behind:number; sample:string[] };
  type GitObserver = { generatedAt:string|null; repoCount:number; dirtyCount:number; aheadCount:number; behindCount:number; repos:GitRepo[] };
  type Dash = { generatedAt:string; workers:Worker[]; activeWorkers:Worker[]; machine:{ worker:string; state:any; controllerAlive:boolean; lastPing:string|null; pings:string[]}; gitObserver:GitObserver; lanes:(Lane & { activeNow?: boolean })[]; events:any[]; recentRuns:any[] };
  let data: Dash | null = null;
  let connected = false;
  let socketEvents: string[] = [];
  let laneSig = '';
  let token = '';
  let answers: Record<string, string> = {};
  let actionStatus: Record<string, string> = {};
  let selectedLane: (Lane & { activeNow?: boolean }) | null = null;
  let drawer: 'lane' | 'git' | 'receipts' | 'workers' | 'events' | null = null;
  $: workRunning = Boolean(data?.machine.controllerAlive && String(data?.machine.state?.status || '').includes('running'));
  $: observeOn = connected;
  $: workState = workRunning ? 'Running' : data?.workers?.some(w => w.status === 'waiting_for_input') ? 'Waiting' : 'Paused';
  $: observeState = observeOn ? 'On' : 'Off';
  $: dirtyRepos = data?.gitObserver?.repos?.filter((repo) => repo.dirty > 0) || [];
  $: lastEvent = [...(data?.events || [])].reverse()[0];
  fetch('/api/token').then(r => r.json()).then(j => token = j.token).catch(() => {});
  async function action(name: 'start' | 'stop' | 'kill', worker = 'portfolio-loop') {
    if (name === 'kill' && !confirm(`Kill ${worker} now?`)) return;
    await fetch('/api/machine/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-machine-token': token }, body: JSON.stringify({ action: name, name: worker }) });
    (window as any).refreshMachine?.();
  }
  async function answer(worker: string) {
    const text = answers[worker] || '';
    if (!text.trim()) { actionStatus[worker] = 'Type an answer first.'; return; }
    actionStatus[worker] = 'Submitting answer…';
    const res = await fetch('/api/machine/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-machine-token': token }, body: JSON.stringify({ action: 'resume', name: worker, answer: text, max: 1 }) });
    const body = await res.text();
    if (!res.ok) { actionStatus[worker] = `Resume failed: ${res.status} ${body.slice(0, 240)}`; return; }
    actionStatus[worker] = 'Answer accepted. Resuming worker…';
    answers[worker] = '';
    (window as any).refreshMachine?.();
  }
  async function dismiss(worker: string) {
    actionStatus[worker] = 'Dismissing…';
    const res = await fetch('/api/machine/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-machine-token': token }, body: JSON.stringify({ action: 'dismiss', name: worker }) });
    actionStatus[worker] = res.ok ? 'Dismissed.' : `Dismiss failed: ${res.status}`;
    (window as any).refreshMachine?.();
  }
  async function openProject(name: string) {
    actionStatus[name] = 'Generating prompt…';
    const res = await fetch('/api/project-prompt', { method: 'POST', headers: { 'content-type': 'application/json', 'x-machine-token': token }, body: JSON.stringify({ project: name }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { actionStatus[name] = `Failed: ${res.status} ${body.error || ''}`; return; }
    try {
      await navigator.clipboard.writeText(body.prompt);
      actionStatus[name] = 'Copied to clipboard. Paste into your agent.';
    } catch {
      actionStatus[name] = 'Copy failed. Prompt printed to console.';
      console.log(`\n=== PROMPT for ${name} ===\n${body.prompt}\n=== END ===`);
    }
  }
  function inspectLane(lane: Lane & { activeNow?: boolean }) {
    selectedLane = lane;
    drawer = 'lane';
  }
  function closeDrawer() {
    drawer = null;
    selectedLane = null;
  }

  const escClass = (s:string) => String(s||'').replace(/[^a-z0-9_-]/gi,'').toLowerCase();
  const icon = () => {
    const st = data?.machine.state?.status || 'missing';
    if ((st.includes('running') || st.includes('starting')) && data?.machine.controllerAlive) return '▶';
    if (st.includes('done') || st.includes('stopped')) return '■';
    if (st.includes('blocked') || st.includes('error') || st.includes('timeout')) return '‼';
    return '▶';
  };
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { connected = true; socketEvents = [...socketEvents, `[${new Date().toLocaleTimeString()}] websocket connected`]; };
    ws.onmessage = (e) => {
      const next: Dash = JSON.parse(e.data);
      const sig = (next.lanes||[]).map(l => `${l.name}:${l.state}:${l.risk}:${l.finding}:${l.next}`).join('|');
      const changed = laneSig && laneSig !== sig;
      laneSig = sig;
      data = next;
      socketEvents = [...socketEvents, `[${new Date().toLocaleTimeString()}] ${changed ? 'lane update' : 'state'}: ${next.machine.state?.status || 'missing'} s${next.machine.state?.session || 0}/${next.machine.state?.max_sessions || 0}`].slice(-100);
    };
    ws.onclose = () => { connected = false; socketEvents = [...socketEvents, `[${new Date().toLocaleTimeString()}] websocket closed; reconnecting`].slice(-100); setTimeout(connect, 1000); };
    ws.onerror = () => { socketEvents = [...socketEvents, `[${new Date().toLocaleTimeString()}] websocket error`].slice(-100); };
    (window as any).refreshMachine = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'refresh' }));
  }
  connect();
</script>

<header>
  <div class="top">
    <div class="brand">
      <div class:play={data?.machine.controllerAlive && String(data?.machine.state?.status||'').includes('running')} class="logo">{icon()}</div>
      <div>
        <div class="title">Cloudflare Machine</div>
        <div class="sub">observe loop / work loop</div>
      </div>
    </div>
    <div class="pills">
      <span class:ok={observeOn} class:bad={!observeOn} class="pill loop-pill">Observe <b>{observeState}</b></span>
      <span class:ok={workRunning} class:waiting={workState === 'Waiting'} class:idle={!workRunning && workState !== 'Waiting'} class="pill loop-pill">Work <b>{workState}</b></span>
      <span class="pill">updated {data ? new Date(data.generatedAt).toLocaleTimeString() : '—'}</span>
      {#if workRunning}
        <button class="secondary" on:click={() => action('stop')}>Pause Work</button>
        <button class="danger" on:click={() => action('kill')}>Kill</button>
      {:else}
        <button on:click={() => action('start')}>Start Work</button>
      {/if}
      <button class="secondary" on:click={() => (window as any).refreshMachine?.()}>Refresh Observe</button>
    </div>
  </div>
</header>

<main>
{#if data}
  <section class="cockpit">
    <div class="instrument status-instrument">
      <div class="instrument-head"><span>Loops</span><button class="micro" on:click={() => (window as any).refreshMachine?.()}>Refresh</button></div>
      <div class="dial-row">
        <button class:lit={observeOn} class="dial" on:click={() => drawer = 'git'}>
          <i class="beacon"></i>
          <span>OBS</span>
          <b>{observeState}</b>
        </button>
        <button class:lit={workRunning} class:warn={workState === 'Waiting'} class="dial" on:click={() => drawer = 'workers'}>
          <i class="beacon"></i>
          <span>WRK</span>
          <b>{workState}</b>
        </button>
      </div>
      <div class="readout">
        <div><span>Repos</span><b>{data.gitObserver?.repoCount || 0}</b></div>
        <div><span>Dirty</span><b>{data.gitObserver?.dirtyCount || 0}</b></div>
        <div><span>Updated</span><b>{data.gitObserver?.generatedAt ? new Date(data.gitObserver.generatedAt).toLocaleTimeString() : 'never'}</b></div>
      </div>
      <div class="actions throttle">
        {#if workRunning}
          <button class="secondary" on:click={() => action('stop')}>Pause Work</button>
          <button class="danger" on:click={() => action('kill')}>Kill</button>
        {:else}
          <button on:click={() => action('start')}>Start Work</button>
        {/if}
      </div>
    </div>

    <div class="instrument activity-instrument">
      <div class="instrument-head"><span>Activity Tape</span><button class="micro" on:click={() => drawer = 'events'}>Open</button></div>
      <div class="current-activity">{data.machine.state?.currentActivity || data.machine.lastPing || 'waiting for activity'}</div>
      <div class="event-tape">
        {#each [...(data.events || [])].reverse().slice(0, 9) as e, i}
          <button class:new={i===0} class="tape-line" on:click={() => drawer = 'events'}>
            <b>{e.worker || 'machine'}</b><span>{e.type}</span><small>s{e.session || data.machine.state?.session || '—'}</small>
          </button>
        {/each}
      </div>
      {#if lastEvent}
        <div class="last-signal">{lastEvent.summary || lastEvent.objective || lastEvent.status || lastEvent.question || lastEvent.ts}</div>
      {/if}
    </div>

    <div class="instrument lane-instrument">
      <div class="instrument-head"><span>Git Radar</span><span class="muted">{data.gitObserver?.repoCount || 0} repos</span></div>
      <div class="lane-grid">
        {#each dirtyRepos as repo (repo.path)}
          <button class="lane-tile {repo.dirty > 100 ? 'critical' : repo.dirty > 10 ? 'medium' : 'low'} active-lane" on:click={() => drawer = 'git'}>
            <span>{repo.branch}</span>
            <b>{repo.path}</b>
            <small>{repo.dirty} dirty</small>
          </button>
        {/each}
        {#each (data.gitObserver?.repos || []).filter((repo) => repo.dirty === 0).slice(0, Math.max(0, 16 - dirtyRepos.length)) as repo (repo.path)}
          <button class="lane-tile low" on:click={() => drawer = 'git'}>
            <span>{repo.branch}</span>
            <b>{repo.path}</b>
            <small>clean</small>
          </button>
        {/each}
      </div>
    </div>

    <div class="instrument aux-instrument">
      <div class="instrument-head"><span>Receipts</span><button class="micro" on:click={() => drawer = 'receipts'}>Open</button></div>
      <div class="receipt-stack">
        {#each data.recentRuns.slice(0, 6) as r}
          <button class="receipt-line" on:click={() => drawer = 'receipts'}>
            <b>{Math.round(r.size/1024)}KB</b>
            <span>{r.path}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  {#if data.workers?.some(w => w.status === 'waiting_for_input')}
    <section class="alert-strip">
      {#each data.workers.filter(w => w.status === 'waiting_for_input') as w (w.name)}
        <div class="question instrument">
          <div class="label">{w.name}</div>
          <pre>{w.question}</pre>
          <textarea bind:value={answers[w.name]} placeholder="Answer this worker…"></textarea>
          <div class="actions"><button type="button" on:click={() => answer(w.name)}>Answer & resume</button><button type="button" class="secondary" on:click={() => dismiss(w.name)}>Dismiss</button></div>
          {#if actionStatus[w.name]}<div class="feedback">{actionStatus[w.name]}</div>{/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if drawer}
    <button class="drawer-backdrop" aria-label="Close drawer" on:click={closeDrawer}></button>
    <aside class="drawer" aria-live="polite">
      <div class="drawer-head">
        <b>{drawer === 'lane' ? selectedLane?.name : drawer === 'git' ? '.git observer' : drawer}</b>
        <button class="micro" on:click={closeDrawer}>Close</button>
      </div>
      {#if drawer === 'lane' && selectedLane}
        <div class="drawer-grid">
          <div><span>State</span><b>{selectedLane.state}</b></div>
          <div><span>Risk</span><b>{selectedLane.risk}</b></div>
          <div><span>Source</span><b>{selectedLane.source}</b></div>
        </div>
        <div class="drawer-block"><span>Why</span><p>{selectedLane.why}</p></div>
        <div class="drawer-block"><span>Finding</span><p>{selectedLane.finding}</p></div>
        <div class="drawer-block"><span>Next</span><p>{selectedLane.next}</p></div>
        <button on:click={() => openProject(selectedLane!.name)}>Copy Agent Prompt</button>
        {#if actionStatus[selectedLane.name]}<div class="feedback">{actionStatus[selectedLane.name]}</div>{/if}
      {:else if drawer === 'git'}
        <div class="drawer-grid">
          <div><span>Repos</span><b>{data.gitObserver?.repoCount || 0}</b></div>
          <div><span>Dirty</span><b>{data.gitObserver?.dirtyCount || 0}</b></div>
          <div><span>Ahead</span><b>{data.gitObserver?.aheadCount || 0}</b></div>
          <div><span>Behind</span><b>{data.gitObserver?.behindCount || 0}</b></div>
          <div><span>Updated</span><b>{data.gitObserver?.generatedAt ? new Date(data.gitObserver.generatedAt).toLocaleString() : 'never'}</b></div>
        </div>
        <div class="drawer-list">
          {#each data.gitObserver?.repos || [] as repo (repo.path)}
            <div class="drawer-row">
              <b>{repo.path}</b>
              <span>{repo.branch} · {repo.head} · {repo.dirty ? `${repo.dirty} dirty` : 'clean'}</span>
              {#if repo.sample?.length}<p>{repo.sample.join('\\n')}</p>{/if}
            </div>
          {/each}
        </div>
      {:else if drawer === 'receipts'}
        <div class="drawer-list">
          {#each data.recentRuns as r}
            <div class="drawer-row"><b>{Math.round(r.size/1024)}KB</b><span>{r.mtime}</span><p>{r.path}</p></div>
          {/each}
        </div>
      {:else if drawer === 'workers'}
        <div class="drawer-list">
          {#each data.workers || [] as w (w.name)}
            <div class="drawer-row"><b>{w.name}</b><span>{w.status} · {w.session || 0}/{w.max_sessions || 0}</span><p>{w.currentActivity || 'no activity'}</p></div>
          {/each}
        </div>
      {:else if drawer === 'events'}
        <div class="drawer-list">
          {#each [...(data.events || [])].reverse().slice(0, 80) as e}
            <div class="drawer-row"><b>{e.worker || 'machine'}</b><span>{e.type} · s{e.session || data.machine.state?.session || '—'}</span><p>{e.summary || e.objective || e.status || e.question || e.ts}</p></div>
          {/each}
          <pre>{socketEvents.slice(-10).reverse().join('\\n')}</pre>
        </div>
      {/if}
    </aside>
  {/if}
{:else}
  <div class="instrument">Connecting…</div>
{/if}
</main>
