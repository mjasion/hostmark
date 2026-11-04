// D235: a pushed delivery runs only after the queue service accepted its receipt handle.
import { MessageNotFoundError, QueueClient } from '@vercel/queue';
import { describe, expect, it, vi } from 'vitest';
import { type LeaseApi, leaseApiOf, verifyPushedDeliveries } from '../src/verify';

const pushed = (over: Record<string, string | null> = {}) => {
  const headers: Record<string, string> = {
    'ce-type': 'com.vercel.queue.v2beta',
    'ce-vqsqueuename': 'image-jobs',
    'ce-vqsconsumergroup': 'api_Squeue_Djs',
    'ce-vqsmessageid': 'msg-1',
    'ce-vqsreceipthandle': 'receipt-1',
    'ce-vqsregion': 'fra1',
    'content-type': 'application/json',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new Request('https://hm.example/api/queue', { method: 'POST', headers, body: '{"forged":true}' });
};

function setup(changeVisibility: LeaseApi['changeVisibility']) {
  const route = vi.fn(async () => Response.json({ status: 'success' }));
  const regions: string[] = [];
  const api: LeaseApi = {
    changeVisibility: vi.fn(changeVisibility),
    withRegion: (r) => {
      regions.push(r);
      return api;
    },
  };
  const post = verifyPushedDeliveries(route, { topic: () => 'image-jobs', api: () => api });
  return { post, route, api, regions };
}

describe('verifyPushedDeliveries', () => {
  it('runs the route only after the service accepted the receipt handle, in the delivery region', async () => {
    const t = setup(async () => ({ success: true }));
    const res = await t.post(pushed());
    expect(res.status).toBe(200);
    expect(t.api.changeVisibility).toHaveBeenCalledWith({
      messageId: 'msg-1',
      queueName: 'image-jobs',
      consumerGroup: 'api_Squeue_Djs',
      receiptHandle: 'receipt-1',
      visibilityTimeoutSeconds: 300,
    });
    expect(t.regions).toEqual(['fra1']);
    expect(t.route).toHaveBeenCalledTimes(1);
  });

  it('refuses a forged delivery with 403 and never runs the route', async () => {
    const t = setup(async () => {
      throw new MessageNotFoundError('msg-1');
    });
    const res = await t.post(pushed({ 'ce-vqsreceipthandle': 'forged' }));
    expect(res.status).toBe(403);
    expect(t.route).not.toHaveBeenCalled();
  });

  it('answers 503 when the service cannot be asked, so a real delivery is pushed again', async () => {
    const t = setup(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await t.post(pushed())).status).toBe(503);
    expect(t.route).not.toHaveBeenCalled();
  });

  it('refuses a delivery for another topic before calling the service', async () => {
    const t = setup(async () => ({ success: true }));
    expect((await t.post(pushed({ 'ce-vqsqueuename': 'other' }))).status).toBe(403);
    expect(t.api.changeVisibility).not.toHaveBeenCalled();
    expect(t.route).not.toHaveBeenCalled();
  });

  it('passes a delivery without a receipt handle to the SDK, which fetches it by id', async () => {
    const t = setup(async () => ({ success: true }));
    expect((await t.post(pushed({ 'ce-vqsreceipthandle': null }))).status).toBe(200);
    expect(t.api.changeVisibility).not.toHaveBeenCalled();
    expect(t.route).toHaveBeenCalledTimes(1);
  });

  it('ignores a region the SDK would refuse', async () => {
    const t = setup(async () => ({ success: true }));
    await t.post(pushed({ 'ce-vqsregion': 'evil.example.com/' }));
    expect(t.regions).toEqual([]);
  });
});

describe('the SDK internals D235 relies on', () => {
  it('exposes its API client with changeVisibility and withRegion', () => {
    const api = leaseApiOf(new QueueClient({ token: 'test' }));
    expect(typeof api.changeVisibility).toBe('function');
    expect(typeof api.withRegion).toBe('function');
    expect(typeof api.withRegion?.('fra1').changeVisibility).toBe('function');
  });
});
