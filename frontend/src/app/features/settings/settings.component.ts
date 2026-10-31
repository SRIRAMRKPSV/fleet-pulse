import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MetricsStreamService } from '../../core/services/metrics-stream.service';
import { RulesEngineService } from '../../core/services/rules-engine.service';
import { TransportType } from '../../core/models/connection.model';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="settings-page">
      <div class="header">
        <h2>Console Settings</h2>
        <p>Configured using an Angular <strong>Template-Driven Form</strong> (Requirement D7).</p>
      </div>

      <!-- Template-Driven Form with [(ngModel)] -->
      <form #settingsForm="ngForm" (ngSubmit)="saveSettings()" class="settings-card">
        <div class="form-group">
          <label for="transport">Preferred Transport</label>
          <select id="transport" name="transport" [(ngModel)]="transport">
            <option value="WebSocket">WebSocket (Primary)</option>
            <option value="SSE">Server-Sent Events (SSE)</option>
            <option value="Polling">HTTP Polling (2-second interval)</option>
          </select>
        </div>

        <div class="actions">
          <button type="submit" class="btn-save">Save Settings</button>
        </div>
      </form>
    </div>
  `,
  styles: [`
    .settings-page {
      max-width: 640px;
      margin: 0 auto;
      padding: 1.5rem 1rem;
      color: #e6edf3;
    }
    .header { margin-bottom: 1.25rem; }
    .header h2 { margin: 0 0 0.25rem 0; font-size: 1.5rem; }
    .header p { margin: 0; color: #8b949e; font-size: 0.85rem; }

    .settings-card {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .form-group { display: flex; flex-direction: column; gap: 0.35rem; }
    .form-group label { font-size: 0.85rem; font-weight: 600; color: #c9d1d9; }
    .form-group input, .form-group select {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      color: #e6edf3;
      font-size: 0.85rem;
      outline: none;
    }
    .form-group input:focus, .form-group select:focus { border-color: #58a6ff; }
    .form-group small { font-size: 0.75rem; color: #8b949e; }

    .actions { display: flex; justify-content: flex-end; }
    .btn-save {
      background: #238636;
      color: white;
      border: none;
      padding: 0.55rem 1.2rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-save:hover { background: #2ea043; }
  `]
})
export class SettingsComponent {
  private stream = inject(MetricsStreamService);
  private rulesEngine = inject(RulesEngineService);

  transport: TransportType = this.stream.preferredTransport();

  saveSettings(): void {
    this.stream.setTransport(this.transport);
    this.rulesEngine.showToast('Transport preference applied.');
  }
}
