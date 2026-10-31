import { MetricPoint } from '../../core/models/metric.model';
import { downsampleMetricPoints } from './service-detail.component';

describe('downsampleMetricPoints', () => {
  it('keeps bounded histories unchanged', () => {
    const points: MetricPoint[] = [
      { timeLabel: '00:00:00', p95: 10, errRate: 1, rps: 100 },
      { timeLabel: '00:00:01', p95: 20, errRate: 2, rps: 200 }
    ];

    expect(downsampleMetricPoints(points)).toEqual(points);
  });

  it('reduces long histories to the requested point limit using bucket averages', () => {
    const points = Array.from({ length: 2000 }, (_value, index) => ({
      timeLabel: `point-${index}`,
      p95: index,
      errRate: index / 100,
      rps: index * 2
    }));

    const result = downsampleMetricPoints(points, 300);

    expect(result).toHaveLength(300);
    expect(result[0].timeLabel).toBe('point-5');
    expect(result[0].p95).toBe(2.5);
    expect(result[299].timeLabel).toBe('point-1999');
  });

  it('rejects invalid limits', () => {
    expect(() => downsampleMetricPoints([], 0)).toThrow('maxPoints must be a positive integer.');
  });
});
