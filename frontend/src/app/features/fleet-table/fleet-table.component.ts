import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MetricsStreamService } from '../../core/services/metrics-stream.service';
import { Microservice, SortColumn } from '../../core/models/service.model';

@Component({
  selector: 'app-fleet-table',
  standalone: true,
  imports: [CommonModule, ScrollingModule],
  template: `
    <div class="table-page">
      <!-- 1. Top Summary Counters -->
      <section class="summary-cards">
        <div class="stat-card" role="button" tabindex="0" (click)="filterStatus('all')" (keydown.enter)="filterStatus('all')" (keydown.space)="$event.preventDefault(); filterStatus('all')">
          <span class="stat-title">Total Services</span>
          <span class="stat-num color-total">{{ stream.statusCounts().total }}</span>
        </div>
        <div class="stat-card" role="button" tabindex="0" (click)="filterStatus('healthy')" (keydown.enter)="filterStatus('healthy')" (keydown.space)="$event.preventDefault(); filterStatus('healthy')">
          <span class="stat-title">Healthy</span>
          <span class="stat-num color-healthy">{{ stream.statusCounts().healthy }}</span>
        </div>
        <div class="stat-card" role="button" tabindex="0" (click)="filterStatus('degraded')" (keydown.enter)="filterStatus('degraded')" (keydown.space)="$event.preventDefault(); filterStatus('degraded')">
          <span class="stat-title">Degraded</span>
          <span class="stat-num color-degraded">{{ stream.statusCounts().degraded }}</span>
        </div>
        <div class="stat-card" role="button" tabindex="0" (click)="filterStatus('down')" (keydown.enter)="filterStatus('down')" (keydown.space)="$event.preventDefault(); filterStatus('down')">
          <span class="stat-title">Down</span>
          <span class="stat-num color-down">{{ stream.statusCounts().down }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-title">Ingest Speed</span>
          <span class="stat-num">{{ stream.eventsPerSecond() }} <small>evt/s</small></span>
        </div>
      </section>

      <!-- 2. Search & Filter Bar (Shareable URL state, Requirement B4) -->
      <div class="filter-bar">
        <div class="search-input-box">
          <span>🔍</span>
          <input
            type="text"
            [value]="stream.searchQuery()"
            (input)="onSearchChange($event)"
            placeholder="Search by service name, id, or team..."
          />
        </div>

        <div class="status-buttons">
          <button
            type="button"
            [class.active]="stream.statusFilter() === 'all'"
            (click)="filterStatus('all')"
          >All</button>
          <button
            type="button"
            class="btn-healthy"
            [class.active]="stream.statusFilter() === 'healthy'"
            (click)="filterStatus('healthy')"
          >Healthy</button>
          <button
            type="button"
            class="btn-degraded"
            [class.active]="stream.statusFilter() === 'degraded'"
            (click)="filterStatus('degraded')"
          >Degraded</button>
          <button
            type="button"
            class="btn-down"
            [class.active]="stream.statusFilter() === 'down'"
            (click)="filterStatus('down')"
          >Down</button>
        </div>

        <span class="row-count">
          Showing <strong>{{ stream.filteredServices().length }}</strong> of {{ stream.services().length }} services
        </span>
      </div>

      <!-- 3. Virtual Scrolling Table (Guarantees < 60 DOM rows at any time, Brief Target) -->
      <div class="table-container" role="table" aria-label="Microservice fleet metrics">
        <!-- Table Header -->
        <div class="table-header" role="row">
          <div class="col-name" role="columnheader" tabindex="0" (click)="sort('name')" (keydown.enter)="sort('name')" (keydown.space)="$event.preventDefault(); sort('name')">Service Name {{ getSortArrow('name') }}</div>
          <div class="col-team" role="columnheader" tabindex="0" (click)="sort('team')" (keydown.enter)="sort('team')" (keydown.space)="$event.preventDefault(); sort('team')">Team {{ getSortArrow('team') }}</div>
          <div class="col-status" role="columnheader" tabindex="0" (click)="sort('status')" (keydown.enter)="sort('status')" (keydown.space)="$event.preventDefault(); sort('status')">Status {{ getSortArrow('status') }}</div>
          <div class="col-metric" role="columnheader" tabindex="0" (click)="sort('p95')" (keydown.enter)="sort('p95')" (keydown.space)="$event.preventDefault(); sort('p95')">p95 Latency {{ getSortArrow('p95') }}</div>
          <div class="col-metric" role="columnheader" tabindex="0" (click)="sort('errRate')" (keydown.enter)="sort('errRate')" (keydown.space)="$event.preventDefault(); sort('errRate')">Error Rate {{ getSortArrow('errRate') }}</div>
          <div class="col-metric" role="columnheader" tabindex="0" (click)="sort('rps')" (keydown.enter)="sort('rps')" (keydown.space)="$event.preventDefault(); sort('rps')">RPS {{ getSortArrow('rps') }}</div>
          <div class="col-action" role="columnheader">Action</div>
        </div>

        <!-- Virtual Scroll Viewport (Renders only visible rows ~20-25 in DOM) -->
        <cdk-virtual-scroll-viewport itemSize="46" class="viewport">
          <div
            *cdkVirtualFor="let item of stream.filteredServices(); trackBy: trackService"
            class="table-row"
            role="row"
            tabindex="0"
            (click)="viewService(item.id)"
            (keydown.enter)="viewService(item.id)"
            (keydown.space)="$event.preventDefault(); viewService(item.id)"
          >
            <div class="col-name" role="cell">
              <span class="item-name">{{ item.name }}</span>
              <span class="item-id">{{ item.id }}</span>
            </div>

            <div class="col-team" role="cell">
              <span class="team-tag">{{ item.team }}</span>
            </div>

            <!-- Status with flash animation on change (Requirement B3) -->
            <div class="col-status" role="cell">
              <span
                class="badge"
                [ngClass]="['badge-' + item.status, item.isFlashing ? 'flash-anim' : '']"
              >
                {{ item.status }}
              </span>
            </div>

            <div class="col-metric font-mono" role="cell">
              <span [class.text-warn]="item.p95 > 300" [class.text-danger]="item.p95 > 500">
                {{ item.p95 }} ms
              </span>
            </div>

            <div class="col-metric font-mono" role="cell">
              <span [class.text-danger]="item.errRate > 3">
                {{ item.errRate }}%
              </span>
            </div>

            <div class="col-metric font-mono text-rps" role="cell">
              {{ item.rps }} req/s
            </div>

            <div class="col-action" role="cell">
              <button
                type="button"
                class="btn-open-chart"
                (keydown.enter)="$event.stopPropagation()"
                (keydown.space)="$event.stopPropagation()"
                (click)="$event.stopPropagation(); viewService(item.id)"
              >
                Open Charts ↗
              </button>
            </div>
          </div>
        </cdk-virtual-scroll-viewport>
      </div>
    </div>
  `,
  styles: [`
    .table-page {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px);
      padding: 1rem;
      gap: 0.75rem;
      box-sizing: border-box;
      background: #090d13;
      color: #e6edf3;
      overflow: hidden;
    }

    /* Summary cards */
    .summary-cards {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 0.75rem;
    }
    .stat-card {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
      cursor: pointer;
    }
    .stat-card:hover { border-color: #388bfd; }
    .stat-title { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; font-weight: 600; }
    .stat-num { font-size: 1.4rem; font-weight: 800; margin-top: 0.2rem; }
    .color-total { color: #58a6ff; }
    .color-healthy { color: #3fb950; }
    .color-degraded { color: #d29922; }
    .color-down { color: #f85149; }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 0.5rem 0.75rem;
    }
    .search-input-box {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 0.35rem 0.6rem;
    }
    .search-input-box input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #e6edf3;
      font-size: 0.85rem;
    }

    .status-buttons { display: flex; gap: 0.35rem; }
    .status-buttons button {
      background: #161b22;
      border: 1px solid #30363d;
      color: #8b949e;
      padding: 0.3rem 0.65rem;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
      font-weight: 600;
    }
    .status-buttons button.active { background: #1f6feb; color: white; border-color: #388bfd; }
    .status-buttons button.btn-healthy.active { background: #238636; border-color: #2ea043; }
    .status-buttons button.btn-degraded.active { background: #9e6a03; border-color: #bb8009; }
    .status-buttons button.btn-down.active { background: #da3633; border-color: #f85149; }

    .row-count { font-size: 0.8rem; color: #8b949e; margin-left: auto; }

    /* Virtual Scroll Table */
    .table-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      overflow: hidden;
    }

    .table-header {
      display: flex;
      align-items: center;
      height: 38px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 0 1rem;
      font-size: 0.75rem;
      font-weight: 700;
      color: #8b949e;
      text-transform: uppercase;
      user-select: none;
    }
    .table-header div { cursor: pointer; }
    .table-header div:hover { color: #58a6ff; }

    .viewport {
      flex: 1;
      height: 100%;
      width: 100%;
    }

    .table-row {
      display: flex;
      align-items: center;
      height: 46px;
      padding: 0 1rem;
      border-bottom: 1px solid #161b22;
      cursor: pointer;
      font-size: 0.85rem;
      box-sizing: border-box;
    }
    .table-row:hover { background: #161b22; }

    /* Column Widths */
    .col-name { flex: 2.2; display: flex; flex-direction: column; }
    .item-name { font-weight: 600; color: #fff; }
    .item-id { font-size: 0.7rem; color: #8b949e; font-family: monospace; }

    .col-team { flex: 1.2; }
    .team-tag { background: #21262d; padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.75rem; color: #8b949e; }

    .col-status { flex: 1.2; }
    .badge {
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: capitalize;
    }
    .badge-healthy { background: #0e2e1e; color: #3fb950; border: 1px solid #238636; }
    .badge-degraded { background: #2e2208; color: #d29922; border: 1px solid #9e6a03; }
    .badge-down { background: #3c1618; color: #f85149; border: 1px solid #da3633; }

    /* Flash Animation (Requirement B3) */
    .flash-anim {
      animation: pulseGlow 1s ease-in-out;
    }
    @keyframes pulseGlow {
      0% { transform: scale(1.15); box-shadow: 0 0 10px currentColor; }
      100% { transform: scale(1); box-shadow: none; }
    }

    .col-metric { flex: 1.2; font-size: 0.85rem; }
    .font-mono { font-family: monospace; }
    .text-warn { color: #d29922; }
    .text-danger { color: #f85149; font-weight: 700; }
    .text-rps { color: #58a6ff; }

    .col-action { flex: 1; text-align: right; }
    .btn-open-chart {
      background: #21262d;
      border: 1px solid #30363d;
      color: #58a6ff;
      border-radius: 4px;
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-open-chart:hover { background: #1f6feb; color: white; }
  `]
})
export class FleetTableComponent implements OnInit {
  stream = inject(MetricsStreamService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    // Read URL query parameters on page load (Requirement B4)
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
    if (typeof params['search'] === 'string') this.stream.searchQuery.set(params['search']);
    const status = params['status'];
    if (status === 'all' || status === 'healthy' || status === 'degraded' || status === 'down') {
      this.stream.statusFilter.set(status);
    }
    const sort = params['sort'];
    if (sort === 'name' || sort === 'team' || sort === 'status' || sort === 'p95' ||
        sort === 'errRate' || sort === 'rps') this.stream.sortColumn.set(sort as SortColumn);
    if (params['dir'] === 'asc' || params['dir'] === 'desc') {
      this.stream.sortDirection.set(params['dir']);
    }
    });
  }

  trackService(_index: number, item: Microservice): string {
    return item.id;
  }

  onSearchChange(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.stream.searchQuery.set(text);
    this.updateUrlParams();
  }

  filterStatus(status: string): void {
    this.stream.statusFilter.set(status);
    this.updateUrlParams();
  }

  sort(col: SortColumn): void {
    if (this.stream.sortColumn() === col) {
      // Toggle ascending / descending
      const newDir = this.stream.sortDirection() === 'asc' ? 'desc' : 'asc';
      this.stream.sortDirection.set(newDir);
    } else {
      this.stream.sortColumn.set(col);
      this.stream.sortDirection.set('desc');
    }
    this.updateUrlParams();
  }

  getSortArrow(col: SortColumn): string {
    if (this.stream.sortColumn() !== col) return '↕';
    return this.stream.sortDirection() === 'asc' ? '↑' : '↓';
  }

  private updateUrlParams(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        search: this.stream.searchQuery() || null,
        status: this.stream.statusFilter() === 'all' ? null : this.stream.statusFilter(),
        sort: this.stream.sortColumn(),
        dir: this.stream.sortDirection()
      },
      queryParamsHandling: 'merge'
    });
  }

  viewService(id: string): void {
    this.router.navigate(['/services', id]);
  }
}
