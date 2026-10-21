import { describe, expect, it } from 'vitest';

import { choiceOf, mediaInput, parseMedia, vimeoVideo, youtubeId } from './media.js';

describe('youtubeId', () => {
  it.each([
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://example.com/watch?v=dQw4w9WgXcQ', null],
  ])('reads %j as %j', (input, id) => {
    expect(youtubeId(input)).toBe(id);
  });
});

describe('vimeoVideo', () => {
  it.each([
    ['https://vimeo.com/76979871', { id: '76979871' }],
    ['https://vimeo.com/76979871/8272103f6e', { id: '76979871', hash: '8272103f6e' }],
    [
      'https://player.vimeo.com/video/76979871?h=8272103f6e',
      { id: '76979871', hash: '8272103f6e' },
    ],
    ['https://vimeo.com/channels/staffpicks/76979871', { id: '76979871' }],
    ['https://vimeo.com/showcase/123/video/76979871', { id: '76979871' }],
    ['https://vimeo.com/about', null],
    ['https://notvimeo.com/76979871', null],
    ['76979871', null],
  ])('reads %j as %j', (input, video) => {
    expect(vimeoVideo(input)).toEqual(video);
  });
});

describe('parseMedia', () => {
  it.each(['image', 'audio', 'video', 'link'] as const)(
    'stores a %s from any https host',
    (choice) => {
      expect(parseMedia(choice, ' https://files.example/a ')).toEqual({
        ok: true,
        media: { kind: choice, url: 'https://files.example/a' },
      });
    },
  );

  it.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://files.example/a'])(
    'refuses %j',
    (input) => {
      for (const choice of ['image', 'audio', 'video', 'link'] as const) {
        expect(parseMedia(choice, input)).toEqual({
          ok: false,
          message: 'Use a full https:// link.',
        });
      }
    },
  );

  it('reads a YouTube or Vimeo link as an embed', () => {
    expect(parseMedia('embed', 'https://youtu.be/dQw4w9WgXcQ')).toEqual({
      ok: true,
      media: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
    });
    expect(parseMedia('embed', 'https://vimeo.com/76979871')).toEqual({
      ok: true,
      media: { kind: 'vimeo', id: '76979871' },
    });
    expect(parseMedia('embed', 'https://example.com/a.mp4')).toEqual({
      ok: false,
      message: 'Paste a YouTube or Vimeo link.',
    });
  });

  it('detects a YouTube or Vimeo page pasted as video, but keeps it as a link when asked', () => {
    expect(parseMedia('video', 'https://vimeo.com/76979871')).toEqual({
      ok: true,
      media: { kind: 'vimeo', id: '76979871' },
    });
    expect(parseMedia('link', 'https://vimeo.com/76979871')).toEqual({
      ok: true,
      media: { kind: 'link', url: 'https://vimeo.com/76979871' },
    });
    expect(parseMedia('video', 'https://vimeo.com/76979871', false)).toEqual({
      ok: true,
      media: { kind: 'video', url: 'https://vimeo.com/76979871' },
    });
  });
});

describe('choiceOf and mediaInput', () => {
  it('round-trips stored media back into the picker and field', () => {
    const vimeo = { kind: 'vimeo', id: '76979871', hash: '8272103f6e' } as const;
    expect(choiceOf(vimeo)).toBe('embed');
    expect(parseMedia('embed', mediaInput(vimeo))).toEqual({ ok: true, media: vimeo });
    expect(choiceOf({ kind: 'youtube', id: 'dQw4w9WgXcQ' })).toBe('embed');
    expect(choiceOf({ kind: 'audio', url: 'https://a.example/b.mp3' })).toBe('audio');
    expect(mediaInput({ kind: 'link', url: 'https://a.example/' })).toBe('https://a.example/');
  });
});
