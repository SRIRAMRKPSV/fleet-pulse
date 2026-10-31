import { afterNextRender, Component, OnInit, OnDestroy, ElementRef, Injector, ViewChild, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MetricsStreamService } from '../../core/services/metrics-stream.service';
import { ApiClientService } from '../../core/services/api-client.service';
import { Microservice } from '../../core/models/service.model';
import { MetricPoint } from '../../core/models/metric.model';
import { Subscription } from 'rxjs';
import { Chart, registerables } from 'chart.js';

// Register standard Chart.js components
Chart.register(...registerables);

export function downsampleMetricPoints(points: MetricPoint[], maxPoints = 300): MetricPoint[] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1) {
    throw new Error('maxPoints must be a positive integer.');
  }
  if (points.length <= maxPoints) return [...points];

  const reduced: MetricPoint[] = [];
  for (let bucket = 0; bucket < maxPoints; bucket++) {
    const start = Math.floor(bucket * points.length / maxPoints);
    const end = Math.floor((bucket + 1) * points.length / maxPoints);
    const slice = points.slice(start, end);
    const totals = slice.reduce(
      (sum, point) => ({
        p95: sum.p95 + point.p95,
        errRate: sum.errRate + point.errRate,
        rps: sum.rps + point.rps
      }),
      { p95: 0, errRate: 0, rps: 0 }
    );
    const divisor = slice.length;
    reduced.push({
      timeLabel: slice[divisor - 1].timeLabel,
      p95: totals.p95 / divisor,
      errRate: totals.errRate / divisor,
      rps: totals.rps / divisor
    });
  }
  return reduced;
}

@Component({
  selector: 'app-service-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="detail-page">
      <!-- 1. Header with breadcrumbs and Fast Switching buttons -->
      <div class="detail-header">
        <div class="breadcrumb">
          <a routerLink="/services">← Back to Fleet Table</a>
          <span>/</span>
          <strong>{{ service()?.name || serviceId() }}</strong>
        </div>

        <div class="service-bar" *ngIf="service() as svc">
          <div class="info-group">
            <span class="status-indicator" [ngClass]="'indicator-' + svc.status"></span>
            <h2>{{ svc.name }}</h2>
            <span class="pill-id">{{ svc.id }}</span>
            <span class="pill-team">Team: {{ svc.team }}</span>
          </div>

          <!-- Fast Switch buttons (Requirement C3) -->
          <div class="switch-group">
            <span>Fast Switch:</span>
            <button (click)="goToAdjacent(-1)">◀ Prev</button>
            <button (click)="goToAdjacent(1)">Next ▶</button>
          </div>
        </div>
      </div>

      <!-- 2. Live KPI Cards -->
      <div class="kpi-cards" *ngIf="service() as svc">
        <div class="kpi-card">
          <span class="kpi-label">Current p95 Latency</span>
          <span class="kpi-val" [class.warn]="svc.p95 > 300" [class.danger]="svc.p95 > 500">
            {{ svc.p95 }} <small>ms</small>
          </span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Current Error Rate</span>
          <span class="kpi-val" [class.danger]="svc.errRate > 3">
            {{ svc.errRate }} <small>%</small>
          </span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Current Throughput</span>
          <span class="kpi-val color-rps">
            {{ svc.rps }} <small>req/s</small>
          </span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Health Status</span>
          <span class="kpi-val" [ngClass]="'color-' + svc.status">
            {{ svc.status | uppercase }}
          </span>
        </div>
      </div>

      <div *ngIf="stream.isStale()" class="error-panel">
        Displaying last-known metrics; live updates are stale.
      </div>
      <div *ngIf="isHistoryLoading()" class="chart-loading" role="status" aria-live="polite">
        Loading historical metrics…
      </div>
      <div *ngIf="!isHistoryLoading() && !hasChartError() && dataPoints.length === 0" class="chart-loading">
        No historical metrics are available yet.
      </div>

      <!-- 3. Error Panel with Retry Button (Requirement R4.1 Graceful degradation) -->
      <div *ngIf="hasChartError()" class="error-panel">
        <span>⚠️ Failed to display live metric charts</span>
        <button (click)="retryLoad()">Retry</button>
      </div>

      <!-- 4. Three Line Charts (Chart.js, Requirement C1 & C2) -->
      <div class="charts-list" *ngIf="!hasChartError() && !isHistoryLoading()">
        <!-- Chart 1: p95 Latency -->
        <div class="chart-box">
          <div class="chart-title">
            <span>📈 p95 Latency (Last 15 Minutes)</span>
            <small>{{ dataPoints.length }} points (Max 300 points per series)</small>
          </div>
          <div *ngIf="chartErrors().latency" class="chart-error">
            Latency chart unavailable. <button type="button" (click)="retryChart('latency')">Retry</button>
          </div>
          <div class="canvas-container" *ngIf="!chartErrors().latency">
            <canvas #latencyCanvas></canvas>
          </div>
        </div>

        <!-- Chart 2: Error Rate -->
        <div class="chart-box">
          <div class="chart-title">
            <span>📊 Error Rate (%)</span>
            <small>Live Sliding Window</small>
          </div>
          <div *ngIf="chartErrors().errorRate" class="chart-error">
            Error-rate chart unavailable. <button type="button" (click)="retryChart('errorRate')">Retry</button>
          </div>
          <div class="canvas-container" *ngIf="!chartErrors().errorRate">
            <canvas #errorCanvas></canvas>
          </div>
        </div>

        <!-- Chart 3: Throughput (RPS) -->
        <div class="chart-box">
          <div class="chart-title">
            <span>🚀 Throughput (Requests Per Second)</span>
            <small>Live Ingest Stream</small>
          </div>
          <div *ngIf="chartErrors().throughput" class="chart-error">
            Throughput chart unavailable. <button type="button" (click)="retryChart('throughput')">Retry</button>
          </div>
          <div class="canvas-container" *ngIf="!chartErrors().throughput">
            <canvas #rpsCanvas></canvas>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .detail-page {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px);
      padding: 1rem 1.25rem;
      gap: 1rem;
      background: #090d13;
      color: #e6edf3;
      overflow-y: auto;
      box-sizing: border-box;
    }

    .detail-header {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 0.85rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .breadcrumb {
      display: flex;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: #8b949e;
    }
    .breadcrumb a { color: #58a6ff; text-decoration: none; font-weight: 600; }
    .breadcrumb a:hover { text-decoration: underline; }

    .service-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .info-group {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .info-group h2 { margin: 0; font-size: 1.3rem; color: #fff; }

    .status-indicator { width: 10px; height: 10px; border-radius: 50%; }
    .indicator-healthy { background: #3fb950; }
    .indicator-degraded { background: #d29922; }
    .indicator-down { background: #f85149; }

    .pill-id, .pill-team {
      font-size: 0.75rem;
      background: #161b22;
      border: 1px solid #30363d;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      color: #8b949e;
    }
    .pill-team { color: #58a6ff; border-color: #1f6feb66; }

    .switch-group { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: #8b949e; }
    .switch-group button {
      background: #161b22;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 0.25rem 0.55rem;
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .switch-group button:hover { background: #21262d; border-color: #58a6ff; color: #58a6ff; }

    /* KPI Cards */
    .kpi-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.75rem;
    }
    .kpi-card {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
    }
    .kpi-label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; font-weight: 600; }
    .kpi-val { font-size: 1.5rem; font-weight: 800; font-family: monospace; margin-top: 0.2rem; }
    .kpi-val small { font-size: 0.85rem; color: #8b949e; }
    .warn { color: #d29922; }
    .danger { color: #f85149; }
    .color-rps { color: #58a6ff; }
    .color-healthy { color: #3fb950; font-family: inherit; font-size: 1.2rem; }
    .color-degraded { color: #d29922; font-family: inherit; font-size: 1.2rem; }
    .color-down { color: #f85149; font-family: inherit; font-size: 1.2rem; }

    .error-panel {
      background: #3c1618;
      border: 1px solid #da3633;
      padding: 1rem;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #ff7b72;
    }
    .error-panel button {
      background: #da3633;
      color: white;
      border: none;
      padding: 0.4rem 0.8rem;
      border-radius: 4px;
      cursor: pointer;
    }

    /* Charts */
    .charts-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .chart-box {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .chart-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
      font-weight: 700;
    }
    .chart-title small { font-size: 0.75rem; color: #8b949e; font-family: monospace; }
    .canvas-container {
      position: relative;
      height: 160px;
      width: 100%;
    }
    .chart-error { color: #ff7b72; font-size: 0.8rem; }
    .chart-loading { color: #8b949e; padding: 1rem; }
  `]
})
export class ServiceDetailComponent implements OnInit, OnDestroy {
  stream = inject(MetricsStreamService);
  private readonly api = inject(ApiClientService);
  private readonly injector = inject(Injector);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  @ViewChild('latencyCanvas') latencyCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('errorCanvas') errorCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('rpsCanvas') rpsCanvas?: ElementRef<HTMLCanvasElement>;

  serviceId = signal<string>('');
  service = signal<Microservice | undefined>(undefined);
  private historyLoadedServiceId = signal<string | null>(null);
  isHistoryLoading = signal(false);
  hasChartError = signal<boolean>(false);
  chartErrors = signal({ latency: false, errorRate: false, throughput: false });

  dataPoints: MetricPoint[] = [];

  private latencyChart?: Chart;
  private errorChart?: Chart;
  private rpsChart?: Chart;

  private routeSub?: Subscription;
  private historyController: AbortController | null = null;
  private chartRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLiveMetricTimestamp: number | null = null;

  constructor() {
    effect(() => {
      const id = this.serviceId();
      const loadedId = this.historyLoadedServiceId();
      const isStale = this.stream.isStale();
      const current = this.stream.services().find(item => item.id === id);
      if (!id || loadedId !== id || !current || isStale ||
          current.lastUpdated === this.lastLiveMetricTimestamp) return;
      this.appendLiveMetric(current);
    });
  }

  ngOnInit(): void {
    // Listen for route parameter changes (e.g. /services/svc-0042)
    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('id');
      if (id) {
        this.loadServiceData(id);
      }
    });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.destroyCharts();
    this.historyController?.abort();
    if (this.chartRetryTimer) clearTimeout(this.chartRetryTimer);
  }

  /**
   * Fast switching logic (Requirement C3):
   * Switching between services must NEVER show another service's data!
   */
  loadServiceData(id: string): void {
    // 1. Clear previous charts and data immediately
    this.destroyCharts();
    if (this.chartRetryTimer) clearTimeout(this.chartRetryTimer);
    this.chartRetryTimer = null;
    this.historyController?.abort();
    const controller = new AbortController();
    this.historyController = controller;
    this.hasChartError.set(false);
    this.chartErrors.set({ latency: false, errorRate: false, throughput: false });
    this.service.set(undefined);
    this.historyLoadedServiceId.set(null);
    this.isHistoryLoading.set(false);
    this.lastLiveMetricTimestamp = null;
    this.dataPoints = [];
    this.serviceId.set(id);

    // 2. Lookup the service from state
    const currentService = this.stream.getServiceById(id);
    if (!currentService) {
      this.hasChartError.set(true);
      return;
    }
    this.service.set(currentService);
    this.isHistoryLoading.set(true);

    // 3. Load 15 minutes of history from backend API (no dummy data)
    void this.api.request(`services/${encodeURIComponent(id)}/history`, {
      signal: controller.signal
    }).then(async response => {
      if (!response.ok) throw new Error(`Request failed (${response.status}).`);
      const body = await response.json();
      if (!Array.isArray(body?.data)) throw new Error('The history response did not contain a data array.');
      if (this.serviceId() !== id) return;
      const validPoints = body.data.filter((point: unknown): point is MetricPoint =>
        !!point && typeof point === 'object' &&
        typeof (point as MetricPoint).timeLabel === 'string' &&
        typeof (point as MetricPoint).p95 === 'number' && Number.isFinite((point as MetricPoint).p95) &&
        typeof (point as MetricPoint).errRate === 'number' && Number.isFinite((point as MetricPoint).errRate) &&
        typeof (point as MetricPoint).rps === 'number' && Number.isFinite((point as MetricPoint).rps));
      this.dataPoints = downsampleMetricPoints(validPoints);
      this.isHistoryLoading.set(false);
      afterNextRender(() => {
        if (controller.signal.aborted || this.serviceId() !== id) return;
        this.setupCharts();
        this.historyLoadedServiceId.set(id);
      }, { injector: this.injector });
    }).catch(error => {
      if (controller.signal.aborted) return;
      console.error('Could not load service history:', error);
      this.isHistoryLoading.set(false);
      this.hasChartError.set(true);
    });
  }

  /**
   * Initializes the 3 Chart.js line charts
   */
  private setupCharts(): void {
    const labels = this.dataPoints.map(point => point.timeLabel);
    const chartErrors = { latency: false, errorRate: false, throughput: false };
    if (this.latencyCanvas) {
      try {
        this.latencyChart = this.createLineChart(
          this.latencyCanvas.nativeElement,
          'Latency (ms)',
          labels,
          this.dataPoints.map(point => point.p95),
          '#f0883e'
        );
      } catch (error) {
        chartErrors.latency = true;
        console.error('Could not initialize latency chart:', error);
      }
    }
    if (this.errorCanvas) {
      try {
        this.errorChart = this.createLineChart(
          this.errorCanvas.nativeElement,
          'Error Rate (%)',
          labels,
          this.dataPoints.map(point => point.errRate),
          '#f85149'
        );
      } catch (error) {
        chartErrors.errorRate = true;
        console.error('Could not initialize error-rate chart:', error);
      }
    }
    if (this.rpsCanvas) {
      try {
        this.rpsChart = this.createLineChart(
          this.rpsCanvas.nativeElement,
          'Throughput (req/s)',
          labels,
          this.dataPoints.map(point => point.rps),
          '#58a6ff'
        );
      } catch (error) {
        chartErrors.throughput = true;
        console.error('Could not initialize throughput chart:', error);
      }
    }
    this.chartErrors.set(chartErrors);
    this.hasChartError.set(!this.latencyChart && !this.errorChart && !this.rpsChart);
  }

  /**
   * Helper function to build a clean Chart.js line chart
   */
  private createLineChart(
    canvas: HTMLCanvasElement,
    label: string,
    labels: string[],
    data: number[],
    color: string
  ): Chart {
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: [...labels],
        datasets: [{
          label,
          data: [...data],
          borderColor: color,
          backgroundColor: color + '15',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false, // Turn off heavy animations for 60fps
        scales: {
          x: {
            ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 10 } },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          },
          y: {
            ticks: { color: '#8b949e', font: { size: 10 } },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }

  private appendLiveMetric(svc: Microservice): void {
    this.service.set(svc);
    this.lastLiveMetricTimestamp = svc.lastUpdated;
    const timeStr = new Date(svc.lastUpdated).toTimeString().split(' ')[0];
    this.dataPoints.push({
      timeLabel: timeStr,
      p95: svc.p95,
      errRate: svc.errRate,
      rps: svc.rps
    });
    if (this.dataPoints.length > 300) this.dataPoints.shift();
    this.appendChartPoint(this.latencyChart, svc.p95, timeStr, 'latency');
    this.appendChartPoint(this.errorChart, svc.errRate, timeStr, 'errorRate');
    this.appendChartPoint(this.rpsChart, svc.rps, timeStr, 'throughput');
  }

  private appendChartPoint(
    chart: Chart | undefined,
    value: number,
    time: string,
    chartName: 'latency' | 'errorRate' | 'throughput'
  ): void {
    if (!chart) return;
    try {
      chart.data.labels?.push(time);
      chart.data.datasets[0].data.push(value);
      if ((chart.data.labels?.length ?? 0) > 300) {
        chart.data.labels?.shift();
        chart.data.datasets[0].data.shift();
      }
      chart.update('none');
    } catch (error) {
      console.error(`Could not update ${chartName} chart:`, error);
      this.chartErrors.update(errors => ({ ...errors, [chartName]: true }));
      chart.destroy();
      if (chartName === 'latency') this.latencyChart = undefined;
      else if (chartName === 'errorRate') this.errorChart = undefined;
      else this.rpsChart = undefined;
      this.hasChartError.set(!this.latencyChart && !this.errorChart && !this.rpsChart);
    }
  }

  private destroyCharts(): void {
    if (this.latencyChart) { this.latencyChart.destroy(); this.latencyChart = undefined; }
    if (this.errorChart) { this.errorChart.destroy(); this.errorChart = undefined; }
    if (this.rpsChart) { this.rpsChart.destroy(); this.rpsChart = undefined; }
  }

  retryLoad(): void {
    this.loadServiceData(this.serviceId());
  }

  retryChart(name: 'latency' | 'errorRate' | 'throughput'): void {
    this.chartErrors.update(errors => ({ ...errors, [name]: false }));
    this.chartRetryTimer = setTimeout(() => {
      this.chartRetryTimer = null;
      if (!this.serviceId() || this.hasChartError()) return;
      const canvas = name === 'latency'
        ? this.latencyCanvas?.nativeElement
        : name === 'errorRate'
          ? this.errorCanvas?.nativeElement
          : this.rpsCanvas?.nativeElement;
      if (!canvas) return;
      try {
        const labels = this.dataPoints.map(point => point.timeLabel);
        const values = name === 'latency'
          ? this.dataPoints.map(point => point.p95)
          : name === 'errorRate'
            ? this.dataPoints.map(point => point.errRate)
            : this.dataPoints.map(point => point.rps);
        const label = name === 'latency' ? 'Latency (ms)'
          : name === 'errorRate' ? 'Error Rate (%)' : 'Throughput (req/s)';
        const color = name === 'latency' ? '#f0883e'
          : name === 'errorRate' ? '#f85149' : '#58a6ff';
        const chart = this.createLineChart(canvas, label, labels, values, color);
        if (name === 'latency') this.latencyChart = chart;
        else if (name === 'errorRate') this.errorChart = chart;
        else this.rpsChart = chart;
        this.hasChartError.set(false);
      } catch (error) {
        console.error(`Could not retry ${name} chart:`, error);
        this.chartErrors.update(errors => ({ ...errors, [name]: true }));
        this.hasChartError.set(!this.latencyChart && !this.errorChart && !this.rpsChart);
      }
    });
  }

  goToAdjacent(offset: number): void {
    const curNum = parseInt(this.serviceId().replace('svc-', ''), 10) || 1;
    let nextNum = curNum + offset;
    if (nextNum < 1) nextNum = 2000;
    if (nextNum > 2000) nextNum = 1;
    this.router.navigate(['/services', 'svc-' + nextNum.toString().padStart(4, '0')]);
  }
}
