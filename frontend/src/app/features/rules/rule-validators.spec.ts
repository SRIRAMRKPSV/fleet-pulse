import { FormControl, FormGroup } from '@angular/forms';
import { metricThresholdValidator, warningLessThanCritical } from './rule-form.component';

describe('Custom Cross-Field Validator', () => {
  it('should pass when warning is strictly less than critical', () => {
    const form = new FormGroup({
      warningThreshold: new FormControl(300),
      criticalThreshold: new FormControl(500)
    }, { validators: [warningLessThanCritical] });

    expect(form.valid).toBe(true);
    expect(form.errors).toBeNull();
  });

  it('should fail when warning is greater than or equal to critical', () => {
    const form = new FormGroup({
      warningThreshold: new FormControl(500),
      criticalThreshold: new FormControl(500)
    }, { validators: [warningLessThanCritical] });

    expect(form.valid).toBe(false);
    expect(form.errors).toEqual({ warningNotLower: true });
  });

  it('accepts zero throughput and rejects negative thresholds', () => {
    const form = new FormGroup({
      metric: new FormControl('rps'),
      threshold: new FormControl(0)
    }, { validators: [metricThresholdValidator] });
    expect(form.errors).toBeNull();

    form.controls['threshold'].setValue(-1);
    expect(form.errors).toEqual({ thresholdMustBeNonNegative: true });
  });

  it('limits error-rate thresholds to the 0–100 percent range', () => {
    const form = new FormGroup({
      metric: new FormControl('errRate'),
      threshold: new FormControl(101)
    }, { validators: [metricThresholdValidator] });

    expect(form.errors).toEqual({ errorRateThresholdOutOfRange: true });
    form.controls['threshold'].setValue(100);
    expect(form.errors).toBeNull();
  });
});
