<script lang="ts">
  import qrcode from 'qrcode-generator';

  let { text, label = 'QR code for your authenticator app' }: { text: string; label?: string } = $props();
  let canvas: HTMLCanvasElement;

  $effect(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const size = n + quiet * 2;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(c + quiet, r + quiet, 1, 1);
  });
</script>

<div role="img" aria-label={label}><canvas bind:this={canvas} aria-hidden="true"></canvas></div>
