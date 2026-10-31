import { Injectable } from '@angular/core';
import { Microservice } from '../models/service.model';
import { MetricPoint } from '../models/metric.model';

/**
 * Service data is now fetched directly from the backend API.
 * All hardcoded frontend sample data has been cleared.
 */
@Injectable({
  providedIn: 'root'
})
export class DummyDataService {
  create2000Services(): Microservice[] {
    return [];
  }

  generate15MinHistory(_serviceId: string): MetricPoint[] {
    return [];
  }
}
