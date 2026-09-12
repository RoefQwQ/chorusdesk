import { beforeEach, describe, expect, it } from 'vitest';
import { activeDialog, dialog, resetDialogs, settleDialog } from '../entrypoints/dashboard/composables/useDialog';

/**
 * The imperative dialog service (audit P2-20).
 *
 * It replaced 48 native `alert()`/`confirm()` calls. The risk in that swap is
 * not cosmetic: `confirm()` returns synchronously, so every converted call site
 * now depends on a promise resolving with the right boolean. A confirm that
 * resolves `true` when the user cancelled would silently perform the
 * destructive action it was guarding.
 *
 * The queue is module state, so the contract that matters most is that only ONE
 * dialog is live at a time and the next appears only after the current one is
 * answered — two stacked confirms is never what a call site meant.
 */
describe('dialog service', () => {
  beforeEach(() => {
    resetDialogs();
  });

  it('shows one dialog at a time and queues the next', async () => {
    const first = dialog.confirm('第一条？');
    const second = dialog.confirm('第二条？');

    expect(activeDialog.value?.message).toBe('第一条？');

    settleDialog(activeDialog.value!.id, true);
    await first;
    expect(activeDialog.value?.message).toBe('第二条？');

    settleDialog(activeDialog.value!.id, false);
    expect(await second).toBe(false);
    expect(activeDialog.value).toBeNull();
  });

  it('resolves confirm with the user answer', async () => {
    const yes = dialog.confirm('删除？');
    settleDialog(activeDialog.value!.id, true);
    expect(await yes).toBe(true);

    const no = dialog.confirm('删除？');
    settleDialog(activeDialog.value!.id, false);
    expect(await no).toBe(false);
  });

  it('a dismissed confirm resolves false — cancel must never read as consent', async () => {
    // The host wires Escape and backdrop to answer(false); this pins the value
    // the call site's `if (!(await dialog.confirm(...))) return;` depends on.
    const pending = dialog.confirm('确定要彻底清空回收站吗？');
    // The host's close handler:
    settleDialog(activeDialog.value!.id, false);
    expect(await pending).toBe(false);
  });

  it('alert resolves with no value and needs no answer beyond dismissal', async () => {
    const shown = dialog.alert('已完成。');
    expect(activeDialog.value?.kind).toBe('alert');
    expect(activeDialog.value?.message).toBe('已完成。');
    settleDialog(activeDialog.value!.id, true);
    await expect(shown).resolves.toBeUndefined();
    expect(activeDialog.value).toBeNull();
  });

  it('ignores a settle for a stale id, so a late answer cannot close the next dialog', async () => {
    const first = dialog.confirm('第一条？');
    const staleId = activeDialog.value!.id;
    settleDialog(staleId, true);
    await first;

    const second = dialog.confirm('第二条？');
    // A duplicate/queued event for the first dialog arrives late.
    settleDialog(staleId, true);

    expect(activeDialog.value?.message).toBe('第二条？');
    settleDialog(activeDialog.value!.id, false);
    expect(await second).toBe(false);
  });

  it('carries the optional labels through to the request', async () => {
    const pending = dialog.confirm('继续？', { title: '确认', confirmLabel: '继续', cancelLabel: '算了' });
    const current = activeDialog.value!;
    expect(current.title).toBe('确认');
    expect(current.confirmLabel).toBe('继续');
    expect(current.cancelLabel).toBe('算了');
    settleDialog(current.id, true);
    await pending;
  });
});
