/**
 * Tests for Ingest stages and the row sink (`src/ingest/stages`), R1 (#45).
 *
 * A custom stage list runs over a real YouTube client on a fake `transport`,
 * a `QuotaCounter` billed by `call`, and a fixed clock; an injected sink
 * records every batch, so the test asserts what reaches the sink, in order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeClient, type Transport } from '../yt/client.ts';
import { QuotaCounter } from '../yt/quota.ts';
import { defaultIngestStages } from './pipeline.ts';
import {
  createBufferingSink,
  runIngestStages,
  type IngestRowBatch,
  type IngestStage,
  type PipelineContext,
} from './stages.ts';

const NOW = new Date('2026-10-29T12:00:00.000Z');

/** Canned YouTube Data API responses, keyed by endpoint path. */
const transport: Transport = async (url) => {
  const { pathname } = new URL(url);
  const body: Record<string, unknown> = {
    '/youtube/v3/channels': {
      items: [
        {
          id: 'UC1',
          snippet: { title: 'Chan' },
          contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
        },
      ],
    },
    '/youtube/v3/videos': {
      items: [
        {
          id: 'v1',
          snippet: { title: 'One', description: '', publishedAt: '2026-01-01T00:00:00Z' },
          contentDetails: { duration: 'PT1M' },
          statistics: { viewCount: '3' },
        },
      ],
    },
    '/youtube/v3/commentThreads': {
      items: [
        {
          id: 'c1',
          snippet: {
            topLevelComment: {
              id: 'c1',
              snippet: {
                authorDisplayName: 'a',
                textOriginal: 'at 1:05',
                publishedAt: '2026-01-02T00:00:00Z',
              },
            },
          },
        },
      ],
    },
  };
  const payload = body[pathname];
  if (payload === undefined) throw new Error(`unexpected request ${pathname}`);
  return new Response(JSON.stringify(payload), { status: 200 });
};

describe('runIngestStages', () => {
  it('runs a custom stage list over shared state and streams rows to the sink in order', async () => {
    const quota = new QuotaCounter();
    const calls: string[] = [];
    const ctx: PipelineContext = {
      client: createYouTubeClient({ apiKey: 'k', transport }),
      call: async (label, run) => {
        calls.push(label);
        const result = await run();
        quota.consume(1);
        return result;
      },
      log: () => {},
      verbose: false,
      fetchedAt: NOW.toISOString(),
    };
    const [resolve, , , comments] = defaultIngestStages;
    assert.ok(resolve !== undefined && comments !== undefined);
    // Skip the uploads playlist: a custom stage enriches a fixed video id.
    const enrichOne: IngestStage = {
      name: 'enrich-one',
      run: async (run) => {
        const page = await run.call('videos.list', () => run.client.listVideos({ id: ['v1'] }));
        const video = page.items[0];
        assert.ok(video !== undefined && run.state.channel !== undefined);
        run.state.videos = [
          {
            id: video.id,
            channelId: run.state.channel.id,
            title: video.snippet.title,
            description: '',
            publishedAt: video.snippet.publishedAt,
            thumbnailUrl: '',
            durationIso8601: video.contentDetails.duration,
            viewCount: 3,
            likeCount: 0,
            commentCount: 0,
            fetchedAt: run.fetchedAt,
          },
        ];
        await run.sink.emit({ videos: run.state.videos });
      },
    };

    const received: IngestRowBatch[] = [];
    const buffer = createBufferingSink();
    const state = await runIngestStages(
      ctx,
      { kind: 'handle', value: 'chan' },
      [resolve, enrichOne, comments],
      {
        emit: async (batch) => {
          received.push(batch);
          await buffer.emit(batch);
        },
      },
    );

    const fetchedAt = NOW.toISOString();
    assert.deepEqual(received, [
      { channel: { id: 'UC1', title: 'Chan', uploadsPlaylistId: 'UU1', fetchedAt } },
      { videos: state.videos },
      {
        comments: [
          {
            id: 'c1',
            videoId: 'v1',
            channelId: 'UC1',
            author: 'a',
            text: 'at 1:05',
            publishedAt: '2026-01-02T00:00:00Z',
            likeCount: 0,
            hasAnchors: 1,
            fetchedAt,
          },
        ],
        anchors: [{ commentId: 'c1', seconds: 65, rawText: '1:05', charPosition: 3 }],
      },
    ]);
    assert.deepEqual(calls, ['channels.list', 'videos.list', 'commentThreads.list video=v1']);
    assert.equal(quota.total, 3);
    assert.equal(buffer.rows().channel.id, 'UC1');
    assert.equal(buffer.rows().comments.length, 1);
  });
});
