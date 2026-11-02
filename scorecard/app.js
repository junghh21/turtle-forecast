/* 거북이 예보 성적표 Application */

(function() {
  'use strict';

  // State
  let rawData = null;
  let colIdx = {};
  let activeFilters = {
    asset: 'all',
    horizon: 'all',
    kind: 'all'
  };
  let currentChartMetric = 'hit'; // 'hit' or 'ret'
  let filtersInitialized = false;

  // Palette for forecasters
  const COLOR_PALETTE = [
    '#2563eb', '#0d9488', '#7c3aed', '#ea580c', '#db2777',
    '#0284c7', '#16a34a', '#ca8a04', '#9333ea', '#e11d48'
  ];
  const SCRIPT_AVG_COLOR = '#475569';

  // Helper to read row by column name dynamically
  function getRowVal(row, colName) {
    const idx = colIdx[colName];
    return idx !== undefined ? row[idx] : undefined;
  }

  // Convert date string/timestamp explicitly to KST (UTC+9), timezone-independent
  function toKSTString(dateInput) {
    if (!dateInput) return '-';
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const kst = new Date(d.getTime() + 9 * 3600 * 1000);
    const y = kst.getUTCFullYear();
    const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const day = String(kst.getUTCDate()).padStart(2, '0');
    const h = String(kst.getUTCHours()).padStart(2, '0');
    const min = String(kst.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min} KST`;
  }

  // Format date for chart X axis
  function formatChartDate(ts) {
    const kst = new Date(ts + 9 * 3600 * 1000);
    const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const d = String(kst.getUTCDate()).padStart(2, '0');
    return `${m}/${d}`;
  }

  // Initialize cols mapping
  function initCols(cols) {
    colIdx = {};
    cols.forEach((col, idx) => {
      colIdx[col] = idx;
    });
  }

  // Filter rows based on activeFilters
  function getFilteredRows() {
    if (!rawData || !rawData.rows) return [];
    return rawData.rows.filter(row => {
      if (activeFilters.asset !== 'all') {
        if (getRowVal(row, 'asset') !== activeFilters.asset) return false;
      }
      if (activeFilters.horizon !== 'all') {
        if (getRowVal(row, 'horizon') !== activeFilters.horizon) return false;
      }
      if (activeFilters.kind !== 'all') {
        if (getRowVal(row, 'kind') !== activeFilters.kind) return false;
      }
      return true;
    });
  }

  // Compute statistics for ranking table
  function computeForecasterStats(filteredRows) {
    const forecasterMap = new Map();

    // Pre-populate with all known forecasters matching kind filter
    rawData.rows.forEach(r => {
      const who = getRowVal(r, 'who');
      const kind = getRowVal(r, 'kind');
      if (activeFilters.kind === 'all' || activeFilters.kind === kind) {
        if (!forecasterMap.has(who)) {
          forecasterMap.set(who, {
            who,
            kind,
            n: 0,
            targetKeySet: new Set(),
            hits: 0,
            momHits: 0,
            momCount: 0,
            brierSum: 0,
            brierCount: 0,
            retSum: 0,
            retCount: 0,
            upRetSum: 0,
            upRetCount: 0
          });
        }
      }
    });

    // Accumulate stats from filteredRows
    filteredRows.forEach(row => {
      const who = getRowVal(row, 'who');
      if (!forecasterMap.has(who)) return;
      const item = forecasterMap.get(who);
      item.n++;

      const tKey = getRowVal(row, 'target_key');
      if (tKey) {
        item.targetKeySet.add(tKey);
      }

      if (getRowVal(row, 'hit') === true) {
        item.hits++;
      }

      const momHit = getRowVal(row, 'momentum_hit');
      if (momHit !== null && momHit !== undefined) {
        item.momCount++;
        if (momHit === true) item.momHits++;
      }

      const pUp = getRowVal(row, 'p_up');
      if (pUp !== null && pUp !== undefined && pUp !== '') {
        const p = Number(pUp);
        const outcome = getRowVal(row, 'outcome_up') ? 1 : 0;
        item.brierSum += Math.pow(p - outcome, 2);
        item.brierCount++;
      }

      const ret = getRowVal(row, 'ret_bp');
      if (ret !== null && ret !== undefined && ret !== '') {
        const r = Number(ret);
        item.retSum += r;
        item.retCount++;
        if (getRowVal(row, 'dir') === 'up') {
          item.upRetSum += r;
          item.upRetCount++;
        }
      }
    });

    // Derive metrics and sort
    const list = Array.from(forecasterMap.values()).map(item => {
      const distinctTargets = item.targetKeySet.size;
      const hitRate = item.n > 0 ? (item.hits / item.n) * 100 : 0;
      const momRate = item.momCount > 0 ? (item.momHits / item.momCount) * 100 : null;
      const diff = momRate !== null && item.n > 0 ? hitRate - momRate : null;
      const brier = item.brierCount > 0 ? item.brierSum / item.brierCount : null;
      const avgRet = item.retCount > 0 ? item.retSum / item.retCount : null;
      const sumRet = item.retCount > 0 ? item.retSum : null;
      const avgUpRet = item.upRetCount > 0 ? item.upRetSum / item.upRetCount : null;

      return {
        ...item,
        distinctTargets,
        hitRate,
        momRate,
        diff,
        brier,
        avgRet,
        sumRet,
        avgUpRet
      };
    });

    // Sort: 독립 결과 >= 20 first; within group: hitRate desc, ties by n desc, then who asc
    list.sort((a, b) => {
      const aSufficient = a.distinctTargets >= 20;
      const bSufficient = b.distinctTargets >= 20;
      if (aSufficient && !bSufficient) return -1;
      if (!aSufficient && bSufficient) return 1;
      if (b.hitRate !== a.hitRate) return b.hitRate - a.hitRate;
      if (b.n !== a.n) return b.n - a.n;
      return a.who.localeCompare(b.who);
    });

    return list;
  }

  // Render Table
  function renderRankingTable(statsList, filteredRows) {
    const tbody = document.getElementById('ranking-tbody');
    const distinctHeaderBadge = document.getElementById('ranking-distinct-targets');

    // Distinct target_key across all filtered rows
    const allDistinctTargets = new Set(filteredRows.map(r => getRowVal(r, 'target_key')).filter(Boolean)).size;
    distinctHeaderBadge.textContent = `독립 결과 ${allDistinctTargets.toLocaleString()}개`;

    if (statsList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty-cell">해당 조건에 일치하는 예보자가 없습니다.</td></tr>';
      return;
    }

    let rank = 1;
    const html = statsList.map((item) => {
      const isInsufficient = item.distinctTargets < 20;
      const rowClass = isInsufficient ? 'insufficient-sample' : '';
      const kindLabel = item.kind === 'llm' ? 'LLM' : '스크립트';
      const kindTagClass = item.kind === 'llm' ? 'llm' : 'script';

      const hitRateStr = item.n > 0 ? `${item.hitRate.toFixed(1)}%` : '-';
      const momRateStr = item.momRate !== null ? `${item.momRate.toFixed(1)}%` : '-';

      let diffStr = '-';
      let diffClass = '';
      if (item.diff !== null) {
        diffStr = `${item.diff > 0 ? '+' : ''}${item.diff.toFixed(1)}%p`;
        diffClass = item.diff > 0 ? 'val-pos' : (item.diff < 0 ? 'val-neg' : '');
      }

      const brierStr = item.brier !== null ? item.brier.toFixed(3) : '-';

      let avgRetStr = '-';
      let avgRetClass = '';
      if (item.avgRet !== null) {
        avgRetStr = `${item.avgRet > 0 ? '+' : ''}${item.avgRet.toFixed(1)} bp`;
        avgRetClass = item.avgRet > 0 ? 'val-pos' : (item.avgRet < 0 ? 'val-neg' : '');
      }

      let sumRetStr = '-';
      let sumRetClass = '';
      if (item.sumRet !== null) {
        sumRetStr = `${item.sumRet > 0 ? '+' : ''}${Math.round(item.sumRet).toLocaleString()} bp`;
        sumRetClass = item.sumRet > 0 ? 'val-pos' : (item.sumRet < 0 ? 'val-neg' : '');
      }

      let avgUpRetStr = '-';
      let avgUpRetClass = '';
      if (item.avgUpRet !== null) {
        avgUpRetStr = `${item.avgUpRet > 0 ? '+' : ''}${item.avgUpRet.toFixed(1)} bp`;
        avgUpRetClass = item.avgUpRet > 0 ? 'val-pos' : (item.avgUpRet < 0 ? 'val-neg' : '');
      }

      const currentRank = isInsufficient ? '-' : rank++;

      return `
        <tr data-code="${item.who}" class="${rowClass}" tabindex="0" role="button" aria-label="${item.who} 상세">
          <td class="col-rank">${currentRank}</td>
          <td class="col-name"><strong>${item.who}</strong>${isInsufficient ? '<span class="badge-insufficient">표본 부족</span>' : ''}</td>
          <td class="col-kind"><span class="kind-tag ${kindTagClass}">${kindLabel}</span></td>
          <td class="col-num">${item.n.toLocaleString()}</td>
          <td class="col-num">${item.distinctTargets.toLocaleString()}</td>
          <td class="col-num"><strong>${hitRateStr}</strong></td>
          <td class="col-num">${momRateStr}</td>
          <td class="col-num ${diffClass}">${diffStr}</td>
          <td class="col-num">${brierStr}</td>
          <td class="col-num ${avgRetClass}">${avgRetStr}</td>
          <td class="col-num ${sumRetClass}">${sumRetStr}</td>
          <td class="col-num ${avgUpRetClass}">${avgUpRetStr}</td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = html;

    // Add click listeners to rows
    tbody.querySelectorAll('tr[data-code]').forEach(tr => {
      const who = tr.getAttribute('data-code');
      tr.addEventListener('click', () => openDetailModal(who));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetailModal(who);
        }
      });
    });
  }

  // Render Heatmap
  function renderHeatmap(statsList, filteredRows) {
    const container = document.getElementById('heatmap-container');
    if (!rawData || !rawData.assets) {
      container.innerHTML = '<div class="empty-cell">자산 정보가 없습니다.</div>';
      return;
    }

    const assetKeys = Object.keys(rawData.assets);
    if (assetKeys.length === 0 || statsList.length === 0) {
      container.innerHTML = '<div class="empty-cell">표시할 히트맵 데이터가 없습니다.</div>';
      return;
    }

    // Count hits and n for each (forecaster, asset) within filtered rows
    const cellData = {};
    statsList.forEach(s => {
      cellData[s.who] = {};
      assetKeys.forEach(k => {
        cellData[s.who][k] = { n: 0, hits: 0 };
      });
    });

    filteredRows.forEach(row => {
      const who = getRowVal(row, 'who');
      const asset = getRowVal(row, 'asset');
      const hit = getRowVal(row, 'hit');
      if (cellData[who] && cellData[who][asset]) {
        cellData[who][asset].n++;
        if (hit === true) cellData[who][asset].hits++;
      }
    });

    let tableHtml = '<table class="heatmap-table"><thead><tr><th class="heatmap-name-cell">예보자</th>';
    assetKeys.forEach(k => {
      const label = rawData.assets[k] || k;
      tableHtml += `<th>${label}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    // Keep exact same order as rankings table
    statsList.forEach(item => {
      tableHtml += `<tr><td class="heatmap-name-cell"><strong>${item.who}</strong></td>`;
      assetKeys.forEach(asset => {
        const data = cellData[item.who][asset];
        if (!data || data.n === 0) {
          // Empty cell when n = 0
          tableHtml += '<td><span class="cell-empty">-</span></td>';
        } else {
          const hitRate = (data.hits / data.n) * 100;
          const diff = hitRate - 50; // -25 to +25
          const ratio = Math.max(-1, Math.min(1, diff / 25));
          let bgColor = 'rgba(148, 163, 184, 0.08)';
          if (ratio > 0) {
            bgColor = `rgba(34, 197, 94, ${(ratio * 0.72 + 0.12).toFixed(2)})`;
          } else if (ratio < 0) {
            bgColor = `rgba(239, 68, 68, ${(Math.abs(ratio) * 0.72 + 0.12).toFixed(2)})`;
          }
          tableHtml += `
            <td style="background-color: ${bgColor};">
              <div class="hm-val">${hitRate.toFixed(1)}%</div>
              <div class="hm-n">n=${data.n}</div>
            </td>
          `;
        }
      });
      tableHtml += '</tr>';
    });

    tableHtml += '</tbody></table>';
    container.innerHTML = tableHtml;
  }

  // Render Trend Chart
  function renderTrendChart(filteredRows) {
    const svgContainer = document.getElementById('chart-svg-container');
    const legendContainer = document.getElementById('chart-legend');

    if (filteredRows.length === 0) {
      svgContainer.innerHTML = '<div class="empty-cell">표시할 시계열 데이터가 없습니다.</div>';
      legendContainer.innerHTML = '';
      return;
    }

    // Separate LLM forecasters and scripts
    const llmRowsByWho = {};
    const scriptRows = [];

    filteredRows.forEach(row => {
      const who = getRowVal(row, 'who');
      const kind = getRowVal(row, 'kind');
      const at = new Date(getRowVal(row, 'at')).getTime();
      const hit = getRowVal(row, 'hit') === true;
      const retBp = Number(getRowVal(row, 'ret_bp')) || 0;

      const pt = { at, hit, retBp };
      if (kind === 'llm') {
        if (!llmRowsByWho[who]) llmRowsByWho[who] = [];
        llmRowsByWho[who].push(pt);
      } else if (kind === 'script') {
        scriptRows.push(pt);
      }
    });

    const seriesList = [];

    // Process LLM series
    let colorIdx = 0;
    Object.keys(llmRowsByWho).sort().forEach(who => {
      const items = llmRowsByWho[who].sort((a, b) => a.at - b.at);
      let runningHits = 0;
      let runningRet = 0;
      const points = items.map((p, idx) => {
        if (p.hit) runningHits++;
        runningRet += p.retBp;
        return {
          at: p.at,
          val: currentChartMetric === 'hit' ? (runningHits / (idx + 1)) * 100 : runningRet
        };
      });
      seriesList.push({
        id: who,
        name: who,
        color: COLOR_PALETTE[colorIdx++ % COLOR_PALETTE.length],
        isScript: false,
        points
      });
    });

    // Process Script Average series
    if (scriptRows.length > 0) {
      scriptRows.sort((a, b) => a.at - b.at);
      const uniqueScriptCount = new Set(filteredRows.filter(r => getRowVal(r, 'kind') === 'script').map(r => getRowVal(r, 'who'))).size || 1;
      let runningHits = 0;
      let runningRet = 0;
      const points = scriptRows.map((p, idx) => {
        if (p.hit) runningHits++;
        runningRet += p.retBp;
        return {
          at: p.at,
          val: currentChartMetric === 'hit' ? (runningHits / (idx + 1)) * 100 : (runningRet / uniqueScriptCount)
        };
      });
      seriesList.push({
        id: '__script_avg',
        name: '스크립트 평균',
        color: SCRIPT_AVG_COLOR,
        isScript: true,
        points
      });
    }

    if (seriesList.length === 0 || seriesList.every(s => s.points.length === 0)) {
      svgContainer.innerHTML = '<div class="empty-cell">표시할 시계열 데이터가 없습니다.</div>';
      legendContainer.innerHTML = '';
      return;
    }

    // Global Bounds
    let minTime = Infinity;
    let maxTime = -Infinity;
    let minVal = currentChartMetric === 'hit' ? 50 : 0;
    let maxVal = currentChartMetric === 'hit' ? 50 : 0;

    seriesList.forEach(s => {
      s.points.forEach(pt => {
        if (pt.at < minTime) minTime = pt.at;
        if (pt.at > maxTime) maxTime = pt.at;
        if (pt.val < minVal) minVal = pt.val;
        if (pt.val > maxVal) maxVal = pt.val;
      });
    });

    if (minTime === maxTime) {
      minTime -= 3600000;
      maxTime += 3600000;
    }

    const width = 800;
    const height = 320;
    const padLeft = 60;
    const padRight = 30;
    const padTop = 25;
    const padBottom = 40;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (currentChartMetric === 'hit') {
      minVal = Math.min(30, Math.floor(minVal - 5));
      maxVal = Math.max(70, Math.ceil(maxVal + 5));
    } else {
      const margin = Math.max(100, Math.abs(maxVal - minVal) * 0.15);
      minVal = Math.floor(minVal - margin);
      maxVal = Math.ceil(maxVal + margin);
    }

    function getX(t) {
      return padLeft + ((t - minTime) / (maxTime - minTime)) * plotW;
    }
    function getY(v) {
      return padTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
    }

    let svg = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`;

    // Y Axis Grid and Labels
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const val = minVal + ((maxVal - minVal) / yTicks) * i;
      const y = getY(val);
      svg += `
        <line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}" stroke="#e2e8f0" stroke-width="1" />
        <text x="${padLeft - 8}" y="${y + 4}" font-size="11" fill="#64748b" text-anchor="end">${currentChartMetric === 'hit' ? val.toFixed(0) + '%' : Math.round(val) + ' bp'}</text>
      `;
    }

    // Reference line (50% for hit rate, 0 bp for cumulative return)
    const refVal = currentChartMetric === 'hit' ? 50 : 0;
    if (refVal >= minVal && refVal <= maxVal) {
      const refY = getY(refVal);
      svg += `
        <line x1="${padLeft}" y1="${refY}" x2="${padLeft + plotW}" y2="${refY}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4,4" />
        <text x="${padLeft + plotW + 4}" y="${refY + 4}" font-size="10" fill="#475569" font-weight="600">${refVal}${currentChartMetric === 'hit' ? '%' : ' bp'}</text>
      `;
    }

    // X Axis Dates
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const t = minTime + ((maxTime - minTime) / xTicks) * i;
      const x = getX(t);
      svg += `
        <line x1="${x}" y1="${padTop + plotH}" x2="${x}" y2="${padTop + plotH + 4}" stroke="#94a3b8" stroke-width="1" />
        <text x="${x}" y="${padTop + plotH + 18}" font-size="11" fill="#64748b" text-anchor="middle">${formatChartDate(t)}</text>
      `;
    }

    // Series Paths
    seriesList.forEach(s => {
      if (s.points.length === 0) return;
      let d = '';
      s.points.forEach((pt, idx) => {
        const x = getX(pt.at);
        const y = getY(pt.val);
        d += (idx === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
      });

      const strokeDash = s.isScript ? 'stroke-dasharray="5,3"' : '';
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.isScript ? '2' : '2.5'}" ${strokeDash} stroke-linecap="round" stroke-linejoin="round" />`;

      const lastPt = s.points[s.points.length - 1];
      const lx = getX(lastPt.at);
      const ly = getY(lastPt.val);
      svg += `<circle cx="${lx}" cy="${ly}" r="3.5" fill="${s.color}" />`;
    });

    svg += '</svg>';
    svgContainer.innerHTML = svg;

    legendContainer.innerHTML = seriesList.map(s => `
      <div class="legend-item" data-series="${s.id}">
        <span class="legend-color" style="background-color: ${s.color}; ${s.isScript ? 'border-top: 2px dashed ' + s.color + '; height: 0;' : ''}"></span>
        <span>${s.name}</span>
      </div>
    `).join('');
  }

  // Open Detail Modal
  function openDetailModal(who) {
    const modal = document.getElementById('detail-modal');
    const titleEl = document.getElementById('detail-title');
    const kindBadge = document.getElementById('detail-kind-badge');
    const sampleBadge = document.getElementById('detail-sample-badge');
    const bodyEl = document.getElementById('detail-body');

    // Filtered predictions for this forecaster
    const filtered = getFilteredRows().filter(r => getRowVal(r, 'who') === who);
    const allForecasterRows = rawData.rows.filter(r => getRowVal(r, 'who') === who);
    const displayRows = filtered.length > 0 ? filtered : allForecasterRows;
    const forecasterKind = displayRows.length > 0 ? getRowVal(displayRows[0], 'kind') : 'llm';

    const distinctTargets = new Set(displayRows.map(r => getRowVal(r, 'target_key')).filter(Boolean)).size;
    const isInsufficient = distinctTargets < 20;

    titleEl.textContent = who;
    kindBadge.textContent = forecasterKind === 'llm' ? 'LLM' : '스크립트';
    kindBadge.className = `kind-tag ${forecasterKind === 'llm' ? 'llm' : 'script'}`;
    sampleBadge.className = isInsufficient ? 'badge-insufficient' : 'badge-insufficient hidden';

    // Horizon stats
    const horizons = ['1h', 'close'];
    const horizonStats = {};
    horizons.forEach(h => {
      horizonStats[h] = { n: 0, hits: 0, targetKeys: new Set(), retSum: 0, retCount: 0 };
    });

    displayRows.forEach(r => {
      const h = getRowVal(r, 'horizon');
      if (horizonStats[h]) {
        horizonStats[h].n++;
        const tKey = getRowVal(r, 'target_key');
        if (tKey) horizonStats[h].targetKeys.add(tKey);
        if (getRowVal(r, 'hit') === true) horizonStats[h].hits++;
        const ret = getRowVal(r, 'ret_bp');
        if (ret !== null && ret !== undefined && ret !== '') {
          horizonStats[h].retSum += Number(ret);
          horizonStats[h].retCount++;
        }
      }
    });

    // Summary Bar
    let summaryHtml = `
      <div class="detail-summary-bar">
        <span class="detail-summary-item">예측 수 n: <strong>${displayRows.length.toLocaleString()}</strong></span>
        <span class="detail-summary-item">독립 결과: <strong>${distinctTargets.toLocaleString()}개</strong></span>
        <span class="detail-summary-item">표본 상태: <strong>${isInsufficient ? '표본 부족 (< 20)' : '정상 (≥ 20)'}</strong></span>
      </div>
    `;

    // Horizon Grid
    let horizonHtml = '<div class="detail-stats-grid">';
    horizons.forEach(h => {
      const st = horizonStats[h];
      const name = h === '1h' ? '1시간 (1h)' : '다음 종가 (close)';
      const hitRate = st.n > 0 ? ((st.hits / st.n) * 100).toFixed(1) + '%' : '-';
      const avgRet = st.retCount > 0 ? `${(st.retSum / st.retCount > 0 ? '+' : '')}${(st.retSum / st.retCount).toFixed(1)} bp` : '-';
      const sumRet = st.retCount > 0 ? `${(st.retSum > 0 ? '+' : '')}${Math.round(st.retSum).toLocaleString()} bp` : '-';
      horizonHtml += `
        <div class="detail-stat-card">
          <div class="stat-card-title">⏱️ ${name}</div>
          <div class="stat-row"><span>예측 수 n (독립 결과)</span><strong>${st.n} (${st.targetKeys.size})</strong></div>
          <div class="stat-row"><span>적중률</span><strong>${hitRate}</strong></div>
          <div class="stat-row"><span>평균 수익</span><strong>${avgRet}</strong></div>
          <div class="stat-row"><span>누적 수익</span><strong>${sumRet}</strong></div>
        </div>
      `;
    });
    horizonHtml += '</div>';

    // Calibration chart: 5 bins 0–0.2, 0.2–0.4, 0.4–0.6, 0.6–0.8, 0.8–1.0
    const bins = [
      { label: '0–0.2', min: 0.0, max: 0.2, count: 0, sumP: 0, upCount: 0 },
      { label: '0.2–0.4', min: 0.2, max: 0.4, count: 0, sumP: 0, upCount: 0 },
      { label: '0.4–0.6', min: 0.4, max: 0.6, count: 0, sumP: 0, upCount: 0 },
      { label: '0.6–0.8', min: 0.6, max: 0.8, count: 0, sumP: 0, upCount: 0 },
      { label: '0.8–1.0', min: 0.8, max: 1.0001, count: 0, sumP: 0, upCount: 0 }
    ];

    let hasPUp = false;
    displayRows.forEach(r => {
      const pUp = getRowVal(r, 'p_up');
      if (pUp !== null && pUp !== undefined && pUp !== '') {
        hasPUp = true;
        const p = Number(pUp);
        const isUp = getRowVal(r, 'outcome_up') === true;
        for (let i = 0; i < bins.length; i++) {
          if (p >= bins[i].min && p < bins[i].max) {
            bins[i].count++;
            bins[i].sumP += p;
            if (isUp) bins[i].upCount++;
            break;
          }
        }
      }
    });

    let calibHtml = '<div class="calib-container">';
    calibHtml += `
      <div class="calib-header">
        <h4>📊 신뢰도 교정 곡선 (Calibration)</h4>
        <div class="calib-legend">
          <span>■ 관측 상승률 (Bar)</span>
          <span>● 평균 예측 확률 (Dot)</span>
          <span>--- 이상적 기준선</span>
        </div>
      </div>
    `;

    if (!hasPUp) {
      calibHtml += '<div class="empty-cell" style="padding: 14px;">확률 예측값(p_up)이 없는 예보자입니다.</div>';
    } else {
      const svgW = 540;
      const svgH = 150;
      const padL = 40;
      const padR = 20;
      const padT = 15;
      const padB = 30;
      const plotW = svgW - padL - padR;
      const plotH = svgH - padT - padB;
      const binW = plotW / bins.length;

      let cSvg = `<svg class="calib-svg" viewBox="0 0 ${svgW} ${svgH}">`;
      // Ideal dashed line
      cSvg += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3,3" />`;
      // Axis lines
      cSvg += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#94a3b8" stroke-width="1" />`;
      cSvg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#94a3b8" stroke-width="1" />`;

      // Y axis labels
      cSvg += `<text x="${padL - 6}" y="${padT + 4}" font-size="9" fill="#64748b" text-anchor="end">100%</text>`;
      cSvg += `<text x="${padL - 6}" y="${padT + plotH / 2 + 3}" font-size="9" fill="#64748b" text-anchor="end">50%</text>`;
      cSvg += `<text x="${padL - 6}" y="${padT + plotH}" font-size="9" fill="#64748b" text-anchor="end">0%</text>`;

      bins.forEach((b, i) => {
        const bx = padL + i * binW;
        const barWidth = binW * 0.44;
        const barX = bx + (binW - barWidth) / 2;
        const obsRate = b.count > 0 ? (b.upCount / b.count) : 0;
        const meanP = b.count > 0 ? (b.sumP / b.count) : (b.min + b.max) / 2;
        const barH = obsRate * plotH;
        const barY = padT + plotH - barH;
        const dotY = padT + plotH - (meanP * plotH);
        const dotX = bx + binW / 2;

        if (b.count > 0) {
          cSvg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barH}" fill="#93c5fd" rx="2" />`;
          cSvg += `<circle cx="${dotX}" cy="${dotY}" r="4" fill="#1e40af" stroke="#ffffff" stroke-width="1" />`;
        }

        cSvg += `<text x="${dotX}" y="${padT + plotH + 13}" font-size="9" fill="#475569" text-anchor="middle">${b.label}</text>`;
        cSvg += `<text x="${dotX}" y="${padT + plotH + 24}" font-size="8" fill="#94a3b8" text-anchor="middle">n=${b.count}</text>`;
      });

      cSvg += '</svg>';
      calibHtml += cSvg;
    }
    calibHtml += '</div>';

    // Latest 15 Predictions Table
    const sortedRecent = [...displayRows].sort((a, b) => {
      const tA = new Date(getRowVal(a, 'at')).getTime();
      const tB = new Date(getRowVal(b, 'at')).getTime();
      return tB - tA;
    }).slice(0, 15);

    let recentHtml = '<div><h4 class="latest-title">📋 최근 예측 내역 (최대 15건)</h4><div class="table-container"><table class="pred-table">';
    recentHtml += '<thead><tr><th>시각 (KST)</th><th>자산</th><th>기간</th><th>p_up</th><th>예측 방향</th><th>결과</th><th>판정</th><th>수익</th></tr></thead><tbody>';

    if (sortedRecent.length === 0) {
      recentHtml += '<tr><td colspan="8" class="empty-cell">예측 내역이 없습니다.</td></tr>';
    } else {
      recentHtml += sortedRecent.map(r => {
        const atKst = toKSTString(getRowVal(r, 'at'));
        const asset = getRowVal(r, 'asset');
        const assetLabel = (rawData.assets && rawData.assets[asset]) ? rawData.assets[asset] : asset;
        const horizon = getRowVal(r, 'horizon') === '1h' ? '1시간' : '다음 종가';
        const pUpVal = getRowVal(r, 'p_up');
        const pUpStr = (pUpVal !== null && pUpVal !== undefined && pUpVal !== '') ? `${(Number(pUpVal) * 100).toFixed(0)}%` : '-';
        const dir = getRowVal(r, 'dir');
        const dirLabel = dir === 'up' ? '상승' : '하락';
        const dirBadge = `<span class="badge-dir ${dir === 'up' ? 'up' : 'down'}">${dirLabel}</span>`;
        const outUp = getRowVal(r, 'outcome_up');
        const outcomeLabel = outUp === true ? '상승' : (outUp === false ? '하락' : '-');
        const hit = getRowVal(r, 'hit');
        const hitBadge = hit === true ? '<span class="hit-icon hit">✓</span>' : (hit === false ? '<span class="hit-icon miss">✗</span>' : '-');
        const ret = getRowVal(r, 'ret_bp');
        let retStr = '-';
        let retClass = '';
        if (ret !== null && ret !== undefined && ret !== '') {
          const numRet = Number(ret);
          retStr = `${numRet > 0 ? '+' : ''}${numRet.toFixed(1)} bp`;
          retClass = numRet > 0 ? 'val-pos' : (numRet < 0 ? 'val-neg' : '');
        }

        return `
          <tr>
            <td>${atKst}</td>
            <td><strong>${assetLabel}</strong></td>
            <td>${horizon}</td>
            <td>${pUpStr}</td>
            <td>${dirBadge}</td>
            <td>${outcomeLabel}</td>
            <td>${hitBadge}</td>
            <td class="${retClass}">${retStr}</td>
          </tr>
        `;
      }).join('');
    }
    recentHtml += '</tbody></table></div></div>';

    bodyEl.innerHTML = summaryHtml + horizonHtml + calibHtml + recentHtml;
    modal.classList.remove('hidden');
  }

  // Close Modal
  function closeModal() {
    const modal = document.getElementById('detail-modal');
    modal.classList.add('hidden');
  }

  // Update All Views
  function updateViews() {
    const filteredRows = getFilteredRows();
    const statsList = computeForecasterStats(filteredRows);

    renderRankingTable(statsList, filteredRows);
    renderHeatmap(statsList, filteredRows);
    renderTrendChart(filteredRows);
  }

  // Setup Filters
  function setupFilters() {
    const assetFiltersContainer = document.getElementById('asset-filters');
    if (rawData && rawData.assets) {
      let assetHtml = `<button class="pill ${activeFilters.asset === 'all' ? 'active' : ''}" data-filter="asset" data-value="all">전체</button>`;
      Object.entries(rawData.assets).forEach(([code, label]) => {
        assetHtml += `<button class="pill ${activeFilters.asset === code ? 'active' : ''}" data-filter="asset" data-value="${code}">${label}</button>`;
      });
      assetFiltersContainer.innerHTML = assetHtml;
    }

    if (!filtersInitialized) {
      filtersInitialized = true;
      document.querySelectorAll('.filter-pills').forEach(group => {
        group.addEventListener('click', (e) => {
          const pill = e.target.closest('.pill');
          if (!pill) return;
          const filterType = pill.getAttribute('data-filter');
          const val = pill.getAttribute('data-value');

          group.querySelectorAll('.pill').forEach(btn => btn.classList.remove('active'));
          pill.classList.add('active');

          activeFilters[filterType] = val;
          updateViews();
        });
      });

      // Chart Metric Toggles
      const toggleHit = document.getElementById('toggle-hit');
      const toggleRet = document.getElementById('toggle-ret');

      toggleHit.addEventListener('click', () => {
        toggleHit.classList.add('active');
        toggleRet.classList.remove('active');
        currentChartMetric = 'hit';
        renderTrendChart(getFilteredRows());
      });

      toggleRet.addEventListener('click', () => {
        toggleRet.classList.add('active');
        toggleHit.classList.remove('active');
        currentChartMetric = 'ret';
        renderTrendChart(getFilteredRows());
      });

      // Modal Listeners
      document.getElementById('btn-close-modal').addEventListener('click', closeModal);
      document.getElementById('detail-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('detail-modal')) {
          closeModal();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
      });
    }
  }

  // Populate Header & Footer
  function populateMeta() {
    const feedUpdatedEl = document.getElementById('feed-updated');
    const totalPredictionsEl = document.getElementById('total-predictions');
    const footerNoteEl = document.getElementById('footer-note');
    const footerVerdictRuleEl = document.getElementById('footer-verdict-rule');

    if (rawData) {
      feedUpdatedEl.textContent = toKSTString(rawData.updated);
      const totalCount = rawData.rows ? rawData.rows.length : 0;
      totalPredictionsEl.textContent = totalCount.toLocaleString();

      footerNoteEl.textContent = rawData.note || '별도의 특이사항이 없습니다.';

      if (rawData.verdict_rule) {
        if (typeof rawData.verdict_rule === 'object') {
          let vrHtml = '<ul style="padding-left: 18px;">';
          Object.entries(rawData.verdict_rule).forEach(([k, v]) => {
            vrHtml += `<li><strong>${k}</strong>: ${typeof v === 'object' ? JSON.stringify(v) : v}</li>`;
          });
          vrHtml += '</ul>';
          footerVerdictRuleEl.innerHTML = vrHtml;
        } else {
          footerVerdictRuleEl.textContent = String(rawData.verdict_rule);
        }
      } else {
        footerVerdictRuleEl.textContent = '등록된 판정 규칙이 없습니다.';
      }
    }
  }

  // Fetch Data
  async function loadData() {
    const errorBox = document.getElementById('error-box');
    const mainContent = document.getElementById('main-content');

    errorBox.classList.add('hidden');
    mainContent.style.display = '';
    mainContent.style.opacity = '0.5';

    try {
      const res = await fetch('../data/scores.json');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      rawData = await res.json();

      if (!rawData.cols || !rawData.rows) {
        throw new Error('데이터 형식이 올바르지 않습니다.');
      }

      initCols(rawData.cols);
      populateMeta();
      setupFilters();
      updateViews();
      mainContent.style.opacity = '1';
      errorBox.classList.add('hidden');
    } catch (err) {
      console.error('Failed to load forecast data:', err);
      errorBox.classList.remove('hidden');
      mainContent.style.display = 'none';
    }
  }

  // App Init
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-retry').addEventListener('click', loadData);
    loadData();
  });
})();