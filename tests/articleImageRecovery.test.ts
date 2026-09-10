// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createImageErrorRecovery } from '../src/utils/media';

/**
 * Recovery for an image inside a `v-html` article body.
 *
 * The reader renders a sanitized article with `v-html`, so its images cannot
 * carry Vue's `@error` binding — they would otherwise be the only images in the
 * app with no fallback when a CDN blocks hotlinking. `proxyImage` runs the
 * request from the service worker, which is what gets past that.
 */

/** Wire the listener exactly as the reader does, in the capture phase. */
function mount(imageHtml: string, proxied: (url: string) => Promise<string | null>) {
  const container = document.createElement('div');
  container.innerHTML = imageHtml;
  container.addEventListener('error', createImageErrorRecovery(proxied), true);
  document.body.appendChild(container);
  return { container, image: container.querySelector('img') as HTMLImageElement };
}

/** Dispatch a real non-bubbling error event, as a failed `<img>` does. */
function fail(image: HTMLImageElement): void {
  image.dispatchEvent(new Event('error'));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createImageErrorRecovery', () => {
  it('retries a failed article image through the proxy', async () => {
    const proxied = vi.fn(async () => 'data:image/png;base64,AAA');
    const { image } = mount('<img src="https://assets.example/a.png">', proxied);

    fail(image);
    await flush();

    expect(proxied).toHaveBeenCalledWith('https://assets.example/a.png');
    expect(image.src).toBe('data:image/png;base64,AAA');
  });

  it('receives the error while capturing, since it does not bubble', async () => {
    // A listener without `capture: true` never sees an <img> error at all, which
    // would make the fallback silently dead code.
    const container = document.createElement('div');
    container.innerHTML = '<img src="https://assets.example/a.png">';
    const image = container.querySelector('img') as HTMLImageElement;
    const bubbleOnly = vi.fn();
    container.addEventListener('error', bubbleOnly);
    document.body.appendChild(container);

    fail(image);

    expect(bubbleOnly).not.toHaveBeenCalled();
  });

  it('attempts each image only once, however many times it fails', async () => {
    // A proxy that also fails must not turn into an endless retry loop.
    const proxied = vi.fn(async () => null);
    const { image } = mount('<img src="https://assets.example/a.png">', proxied);

    fail(image);
    await flush();
    fail(image);
    fail(image);
    await flush();

    expect(proxied).toHaveBeenCalledTimes(1);
  });

  it('leaves the original src when the proxy also fails', async () => {
    const { image } = mount('<img src="https://assets.example/a.png">', async () => null);

    fail(image);
    await flush();

    expect(image.src).toBe('https://assets.example/a.png');
  });

  it('ignores an error that did not come from an image', async () => {
    const proxied = vi.fn(async () => 'data:image/png;base64,AAA');
    const container = document.createElement('div');
    container.innerHTML = '<video src="https://assets.example/a.mp4"></video>';
    container.addEventListener('error', createImageErrorRecovery(proxied), true);
    document.body.appendChild(container);

    container.querySelector('video')!.dispatchEvent(new Event('error'));
    await flush();

    expect(proxied).not.toHaveBeenCalled();
  });

  it('survives a proxy rejection without leaving the image in a broken state', async () => {
    const { image } = mount('<img src="https://assets.example/a.png">', async () => {
      throw new Error('runtime gone');
    });

    fail(image);
    await flush();

    expect(image.src).toBe('https://assets.example/a.png');
  });
});
