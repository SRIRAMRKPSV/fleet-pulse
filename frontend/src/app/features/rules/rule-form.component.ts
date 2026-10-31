import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AsyncValidatorFn,
  AbstractControl,
  FormControl,
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { RulesEngineService } from '../../core/services/rules-engine.service';
import { AlertRule, MetricType, OperatorType } from '../../core/models/rule.model';
import { CanComponentDeactivate } from '../../core/guards/unsaved-changes.guard';
import { map, of } from 'rxjs';

type ConditionFormGroup = FormGroup<{
  metric: FormControl<MetricType>;
  operator: FormControl<OperatorType>;
  threshold: FormControl<number | null>;
  durationSec: FormControl<number | null>;
}>;

type RuleFormGroup = FormGroup<{
  name: FormControl<string>;
  warningThreshold: FormControl<number | null>;
  criticalThreshold: FormControl<number | null>;
  conditions: FormArray<ConditionFormGroup>;
}>;

export function metricThresholdValidator(control: AbstractControl): ValidationErrors | null {
  const metric = control.get('metric')?.value as MetricType | undefined;
  const threshold = control.get('threshold')?.value;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  if (threshold < 0) return { thresholdMustBeNonNegative: true };
  if (metric === 'errRate' && threshold > 100) return { errorRateThresholdOutOfRange: true };
  return null;
}

/**
 * Custom Cross-Field Validator (Requirement D3):
 * Enforces that the Warning threshold must be lower than the Critical threshold.
 */
export function warningLessThanCritical(control: AbstractControl): ValidationErrors | null {
  const warning = control.get('warningThreshold')?.value;
  const critical = control.get('criticalThreshold')?.value;

  if (warning !== null && critical !== null && warning !== '' && critical !== '') {
    if (Number(warning) >= Number(critical)) {
      return { warningNotLower: true };
    }
  }
  return null;
}

@Component({
  selector: 'app-rule-form',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  template: `
    <div class="form-page">
      <div class="form-header">
        <a routerLink="/rules">← Back to Rules</a>
        <h2>{{ isEdit() ? 'Edit Alert Rule' : 'Create New Alert Rule' }}</h2>
        <p>Configure automated conditions that fire when service metrics breach thresholds.</p>
      </div>

      <!-- Reactive Form (Requirement D1) -->
      <form [formGroup]="ruleForm" (ngSubmit)="onSubmit()" class="form-box">
        <!-- 1. Rule Name -->
        <div class="form-group">
          <label for="name">Rule Name *</label>
          <input
            id="name"
            type="text"
            formControlName="name"
            placeholder="e.g. High Checkout Latency"
          />
          <span *ngIf="ruleForm.controls.name.hasError('minlength') && ruleForm.controls.name.touched" class="err-text">
            Rule name must be at least 3 characters.
          </span>
          <span *ngIf="ruleForm.controls.name.hasError('nameTaken') && ruleForm.controls.name.touched" class="err-text">
            That rule name is already in use, or availability could not be verified.
          </span>
        </div>

        <!-- 2. Thresholds with Cross-field validation (Requirement D3) -->
        <div class="grid-2">
          <div class="form-group">
            <label for="warning">Warning Threshold</label>
            <input id="warning" type="number" formControlName="warningThreshold" placeholder="e.g. 300" />
          </div>
          <div class="form-group">
            <label for="critical">Critical Threshold *</label>
            <input id="critical" type="number" formControlName="criticalThreshold" placeholder="e.g. 500" />
          </div>
        </div>

        <div *ngIf="ruleForm.hasError('warningNotLower')" class="cross-val-box">
          ⚠️ Warning threshold must be lower than Critical threshold (Requirement D3).
        </div>

        <!-- 3. Dynamic Conditions FormArray (Requirement D1 & D2) -->
        <div class="conditions-box">
          <div class="conditions-header">
            <h3>Trigger Conditions</h3>
            <button type="button" class="btn-add" (click)="addCondition()">+ Add Condition</button>
          </div>

          <div formArrayName="conditions" class="conditions-list">
            <div
              *ngFor="let cond of conditionsArray.controls; let i = index"
              [formGroupName]="i"
              class="condition-row"
            >
              <span>#{{ i + 1 }}</span>

              <div class="form-group">
                <label [for]="'metric-' + i">Metric</label>
                <select [id]="'metric-' + i" formControlName="metric" (change)="onMetricChange(i)">
                  <option value="p95">p95 Latency (ms)</option>
                  <option value="errRate">Error Rate (%)</option>
                  <option value="rps">Throughput (req/s)</option>
                </select>
              </div>

              <div class="form-group">
                <label [for]="'operator-' + i">Operator</label>
                <select [id]="'operator-' + i" formControlName="operator">
                  <option value=">">&gt; (Greater than)</option>
                  <option value=">=">&gt;= (Greater or equal)</option>
                  <option value="<">&lt; (Less than)</option>
                  <option value="<=">&lt;= (Less or equal)</option>
                </select>
              </div>

              <div class="form-group">
                <label [for]="'threshold-' + i">Threshold ({{ getUnit(i) }})</label>
                <input [id]="'threshold-' + i" type="number" formControlName="threshold" min="0" [max]="getMaxThreshold(i)" />
                <!-- Show error if threshold is 0 or below -->
                <span
                  *ngIf="conditionsArray.at(i).get('threshold')?.invalid && conditionsArray.at(i).get('threshold')?.touched"
                  class="err-text"
                >
                  Enter a valid non-negative threshold; error rate cannot exceed 100%.
                </span>
              </div>

              <div class="form-sec form-group">
                <label [for]="'duration-' + i">Duration (sec)</label>
                <input [id]="'duration-' + i" type="number" formControlName="durationSec" min="1" />
                <!-- Show error if duration is 0 or below -->
                <span
                  *ngIf="conditionsArray.at(i).get('durationSec')?.invalid && conditionsArray.at(i).get('durationSec')?.touched"
                  class="err-text"
                >
                  Duration must be greater than 0.
                </span>
              </div>

              <button
                type="button"
                class="btn-del"
                (click)="removeCondition(i)"
                [disabled]="conditionsArray.length <= 1"
              >✕</button>
            </div>
          </div>
        </div>

        <!-- Form Actions -->
        <div class="form-actions">
          <a routerLink="/rules" class="btn-cancel">Cancel</a>
          <button type="submit" class="btn-submit" [disabled]="ruleForm.invalid || ruleForm.pending || isSubmitting()">
            {{ isEdit() ? 'Update Rule' : 'Save Rule' }}
          </button>
        </div>
      </form>
    </div>
  `,
  styles: [`
    .form-page {
      max-width: 760px;
      margin: 0 auto;
      padding: 1.5rem 1rem;
      color: #e6edf3;
    }
    .form-header { margin-bottom: 1.25rem; }
    .form-header a { color: #58a6ff; text-decoration: none; font-size: 0.85rem; font-weight: 600; }
    .form-header h2 { margin: 0.5rem 0 0.25rem 0; font-size: 1.5rem; }
    .form-header p { margin: 0; color: #8b949e; font-size: 0.85rem; }

    .form-box {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .form-sec { display: flex; flex-direction: column; gap: 0.35rem; width:85px }  
    .form-group { display: flex; flex-direction: column; gap: 0.35rem; flex: 1; }
    .form-group label { font-size: 0.8rem; font-weight: 600; color: #c9d1d9; }
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

    .err-text { font-size: 0.75rem; color: #f85149; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }

    .cross-val-box {
      background: #3c1618;
      border: 1px solid #da3633;
      color: #ff7b72;
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      font-size: 0.8rem;
    }

    .conditions-box {
      border-top: 1px solid #21262d;
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .conditions-header { display: flex; justify-content: space-between; align-items: center; }
    .conditions-header h3 { margin: 0; font-size: 1rem; color: #58a6ff; }

    .btn-add {
      background: #21262d;
      border: 1px solid #30363d;
      color: #58a6ff;
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .btn-add:hover { background: #1f6feb; color: white; }

    .conditions-list { display: flex; flex-direction: column; gap: 0.6rem; }
    .condition-row {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
    }
    .condition-row span { font-weight: 700; color: #8b949e; margin-bottom: 0.6rem; }

    .btn-del {
      background: transparent;
      border: 1px solid #30363d;
      color: #8b949e;
      padding: 0.45rem 0.65rem;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 0.05rem;
    }
    .btn-del:hover:not(:disabled) { color: #f85149; border-color: #da3633; }
    .btn-del:disabled { opacity: 0.3; }

    .form-actions { display: flex; justify-content: flex-end; align-items: center; gap: 0.75rem; margin-top: 0.5rem; }
    .btn-cancel { color: #8b949e; text-decoration: none; font-size: 0.85rem; padding: 0.5rem 0.75rem; }
    .btn-submit {
      background: #238636;
      border: none;
      color: white;
      padding: 0.55rem 1.25rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-submit:hover:not(:disabled) { background: #2ea043; }
    .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
  `]
})
export class RuleFormComponent implements OnInit, CanComponentDeactivate {
  private fb = inject(FormBuilder);
  private rulesEngine = inject(RulesEngineService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  isEdit = signal(false);
  isSubmitting = signal(false);
  ruleId = signal<string | null>(null);
  ruleForm!: RuleFormGroup;

  private isSaved = false;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.isEdit.set(true);
      this.ruleId.set(id);
    }

    this.initForm();

    if (id) {
      const existing = this.rulesEngine.rules().find(r => r.id === id);
      if (existing) {
        this.ruleForm.patchValue({
          name: existing.name,
          warningThreshold: existing.warningThreshold,
          criticalThreshold: existing.criticalThreshold
        });
        this.conditionsArray.clear();
        for (const condition of existing.conditions) {
          this.addCondition(condition.metric, condition.operator, condition.threshold, condition.durationSec);
        }
      }
    }
  }

  private initForm(): void {
    this.ruleForm = this.fb.group({
      name: this.fb.nonNullable.control('', {
        validators: [Validators.required, Validators.minLength(3)],
        asyncValidators: [this.uniqueNameValidator()]
      }),
      warningThreshold: this.fb.control<number | null>(300, Validators.min(0)),
      criticalThreshold: this.fb.control<number | null>(500, [Validators.required, Validators.min(0)]),
      conditions: this.fb.array<ConditionFormGroup>([])
    }, {
      validators: [warningLessThanCritical] // Cross-field validation (Requirement D3)
    });

    // Start with 1 condition
    this.addCondition('p95', '>', 500, 10);
  }

  get conditionsArray(): FormArray<ConditionFormGroup> {
    return this.ruleForm.controls.conditions;
  }

  addCondition(metric: MetricType = 'p95', operator: OperatorType = '>', threshold = 500, durationSec = 10): void {
    const group: ConditionFormGroup = this.fb.group({
      metric: this.fb.nonNullable.control(metric, Validators.required),
      operator: this.fb.nonNullable.control(operator, Validators.required),
      threshold: this.fb.control<number | null>(threshold, [Validators.required, Validators.min(0)]),
      durationSec: this.fb.control<number | null>(durationSec, [Validators.required, Validators.min(1)])
    }, { validators: [metricThresholdValidator] });
    this.conditionsArray.push(group);
  }

  removeCondition(index: number): void {
    if (this.conditionsArray.length > 1) {
      this.conditionsArray.removeAt(index);
    }
  }

  onMetricChange(index: number): void {
    const group = this.conditionsArray.at(index);
    const metric = group.get('metric')?.value as MetricType;
    if (metric === 'errRate') {
      group.get('threshold')?.setValue(5);
    } else if (metric === 'p95') {
      group.get('threshold')?.setValue(500);
    } else {
      group.get('threshold')?.setValue(100);
    }
  }

  getUnit(index: number): string {
    const metric = this.conditionsArray.at(index).get('metric')?.value;
    if (metric === 'errRate') return '%';
    if (metric === 'p95') return 'ms';
    return 'req/s';
  }

  getMaxThreshold(index: number): number | null {
    return this.conditionsArray.at(index).controls.metric.value === 'errRate' ? 100 : null;
  }

  private uniqueNameValidator(): AsyncValidatorFn {
    return control => {
      const name = String(control.value ?? '').trim();
      if (name.length < 3) return of(null);
      return this.rulesEngine.checkNameAvailableRemotely(name, this.ruleId() ?? undefined).pipe(
        map(available => available ? null : { nameTaken: true })
      );
    };
  }

  // Requirement D5: Ask confirmation before leaving unsaved form
  canDeactivate(): boolean {
    if (this.isSaved || !this.ruleForm.dirty) {
      return true;
    }
    return confirm('You have unsaved changes in this rule. Do you really want to leave?');
  }

  async onSubmit(): Promise<void> {
    if (this.ruleForm.invalid || this.ruleForm.pending || this.isSubmitting()) return;

    const val = this.ruleForm.getRawValue();
    const rule: AlertRule = {
      id: this.ruleId() || crypto.randomUUID(),
      name: val.name.trim(),
      warningThreshold: val.warningThreshold ?? undefined,
      criticalThreshold: val.criticalThreshold ?? undefined,
      conditions: val.conditions.map(condition => ({
        ...condition,
        threshold: condition.threshold ?? 0,
        durationSec: condition.durationSec ?? 0
      })),
      enabled: true,
      createdAt: 'Just now'
    };

    this.isSubmitting.set(true);
    try {
      const saved = await this.rulesEngine.saveRule(rule);
      if (saved) {
        this.isSaved = true;
        this.router.navigate(['/rules']);
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
