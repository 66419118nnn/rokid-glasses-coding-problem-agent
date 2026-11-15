<script type="application/json" def>
{
  "navigationBarTitleText": "拍题解题"
}
</script>

<script setup>
import wx from 'wx';
import { BRIDGE_URL, BRIDGE_AK, QUESTION } from '../../config.js';

// 低于这个平均亮度就当成“相机还没出画面”，重拍，不把黑图发给模型。
const MIN_LUMA = 12;
const MODES = ['default', 'wide', 'telephoto'];
const PREVIEW_WAIT_MS = 3000;
const SCROLL_STEP = 130;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  data: {
    phase: 'aim',        // aim | busy | confirm | answer
    status: '相机启动中…',
    hint: '单击镜腿拍照',
    answer: '',
    diag: '',
    previewSrc: '',
    photoSrc: '',
    shotCount: 0,
    confirmFocus: 0,
    scrollTop: 0,
    busy: false,
  },

  onLoad() {
    this.camera = null;
    this.stream = null;
    this.previewUrl = '';
    this.previewReady = false;
    this.shots = [];
    this.captureMode = 'new';
    console.log('[v8] onLoad');
    this.startCamera();
  },

  onUnload() {
    if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
    this.stopCamera();
  },

  onHostFocus() {
    if (this.data.phase === 'aim' && !this.stream) this.startPreview();
  },

  // 只有 Enter（镜腿单击）触发拍照。GlobalHook 在滑动时也会报，不能当拍摄用。
  triggerCapture(source) {
    if (this.lastTriggerAt && Date.now() - this.lastTriggerAt < 800) return;
    this.lastTriggerAt = Date.now();
    console.log('[v6] trigger', source);
    if (this.data.phase === 'answer') this.retake();
    else if (this.data.phase === 'confirm') this.confirmUpload();
    else this.shoot();
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (this.data.phase === 'confirm') {
      if (code === 'ArrowUp' || code === 'ArrowDown') {
        const next = (this.data.confirmFocus + (code === 'ArrowDown' ? 1 : 2)) % 3;
        this.setData({ confirmFocus: next });
        console.log('[v8] confirm focus', next);
        return;
      }
      if (code === 'Enter') {
        if (this.lastConfirmAt && Date.now() - this.lastConfirmAt < 800) return;
        this.lastConfirmAt = Date.now();
        this.activateConfirm();
        return;
      }
      return;
    }
    if (code === 'Enter') {
      this.triggerCapture('enter');
      return;
    }
    if (code === 'ArrowDown' || code === 'ArrowUp') {
      const delta = code === 'ArrowDown' ? SCROLL_STEP : -SCROLL_STEP;
      const base = Number.isFinite(this.answerScrollTop) ? this.answerScrollTop : (this.data.scrollTop || 0);
      const next = Math.max(0, base + delta);
      this.answerScrollTop = next;
      this.setData({ scrollTop: next });
      console.log('[v8] scroll', next);
    }
  },

  activateConfirm() {
    if (this.data.confirmFocus === 1) this.addShot();
    else if (this.data.confirmFocus === 2) this.retake();
    else this.confirmUpload();
  },

  onAnswerScroll(event) {
    const top = event && event.detail ? Number(event.detail.scrollTop) : Number.NaN;
    if (Number.isFinite(top)) this.answerScrollTop = top;
  },

  // 接管确认和滑动，拦掉宿主默认行为（单击进系统相机、滑动动根视图）。
  onKeyUp(event) {
    const code = event && event.code;
    if (code === 'Enter' || code === 'ArrowUp' || code === 'ArrowDown') {
      if (event.preventDefault) event.preventDefault();
    }
  },

  onShootTap() {
    this.triggerCapture('tap');
  },

  onPreviewPlaying() {
    this.previewReady = true;
    console.log('[v6] preview playing');
    if (this.data.phase === 'aim') {
      this.setData({ status: '对准题目，单击镜腿拍照' });
    }
  },

  startCamera(keepShots = false) {
    this.stopCamera();
    if (!keepShots) this.shots = [];
    this.pendingPhoto = null;
    this.answerScrollTop = 0;
    this.setData({ phase: 'aim', busy: false, answer: '', diag: '', photoSrc: '', shotCount: 0, confirmFocus: 0, scrollTop: 0, status: '相机启动中…' });
    try {
      if (typeof wx === 'undefined' || !wx.media || typeof wx.media.createCameraContext !== 'function') {
        this.setData({ status: '这个运行时不支持 wx.media 相机' });
        return;
      }
      this.camera = wx.media.createCameraContext();
      if (!this.camera) {
        this.setData({ status: '相机不可用（运行时未开放）' });
        return;
      }
      this.startPreview();
    } catch (error) {
      this.setData({ status: '相机启动失败：' + (error && error.message ? error.message : String(error)) });
    }
  },

  // 只给取景用的轻量预览：官方扫描示例同款的 640×480 小流，拍完立刻释放。
  async startPreview() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('没有拿到摄像头轨道');
      const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
      this.stream = stream;
      this.previewUrl = URL.createObjectURL(stream);
      this.previewReady = false;
      console.log('[v6] preview', settings ? settings.width + 'x' + settings.height : 'unknown');
      this.setData({ previewSrc: this.previewUrl, status: '对准题目，单击镜腿拍照' });
    } catch (error) {
      console.log('[v6] preview failed', error && error.message ? error.message : String(error));
      this.setData({ status: '取景不可用，仍可单击镜腿拍照' });
    }
  },

  stopPreview() {
    if (this.stream) {
      try { this.stream.getTracks().forEach((track) => track.stop()); } catch (_) {}
    }
    this.stream = null;
    this.previewReady = false;
    if (this.previewUrl) {
      try { URL.revokeObjectURL(this.previewUrl); } catch (_) {}
    }
    this.previewUrl = '';
  },

  stopCamera() {
    this.stopPreview();
    this.camera = null;
  },

  async inspect(data, mimeType) {
    try {
      const blob = new Blob([data], { type: mimeType || 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      const width = 96;
      const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width));
      const canvas = new Canvas(width, height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        count += 1;
      }
      const result = {
        luma: count > 0 ? Math.round(sum / count) : 0,
        width: bitmap.width,
        height: bitmap.height,
      };
      bitmap.close();
      return result;
    } catch (_) {
      return { luma: -1, width: 0, height: 0 };
    }
  },

  async shoot() {
    if (this.data.busy) return;
    console.log('[v6] shoot', this.data.phase);
    if (!this.camera) {
      this.setData({ status: '相机还没准备好，等一秒再按' });
      return;
    }
    this.setData({ busy: true, phase: 'busy', status: '拍照中…', answer: '', diag: '' });

    let photo = null;
    let info = { luma: -1, width: 0, height: 0 };
    let usedMode = MODES[0];
    try {
      // 取景流只用于对准；拍照前释放，让系统相机拿回设备。
      this.stopPreview();
      this.setData({ previewSrc: '' });
      await sleep(500);
      try {
        const fresh = wx.media.createCameraContext();
        if (fresh) this.camera = fresh;
      } catch (_) {}

      let captured = false;
      for (const mode of MODES) {
        photo = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            photo = await this.camera.takePhoto({ quality: 'high', mode: mode, enableSystemPreview: false });
            break;
          } catch (shotError) {
            console.error('[v6] takePhoto failed', mode, 'attempt', attempt, shotError && shotError.message ? shotError.message : String(shotError));
            if (attempt === 2) this.setData({ diag: mode + ' 拍照失败' });
            else await sleep(700);
          }
        }
        if (!photo || !photo.data) {
          if (!photo) break;
          this.setData({ diag: mode + ' 没有返回图像' });
          break;
        }
        info = await this.inspect(photo.data, photo.mimeType);
        usedMode = mode;
        console.log('[v6] capture', mode, info.width + 'x' + info.height, 'luma=' + info.luma);
        this.setData({ diag: mode + ' ' + info.width + '×' + info.height + ' 亮度 ' + info.luma });
        if (info.luma < 0 || info.luma >= MIN_LUMA) {
          captured = true;
          break;
        }
        this.setData({ status: mode + ' 没有画面，换一种模式…' });
        await sleep(600);
      }

      if (!captured) {
        this.setData({ phase: 'aim', busy: false, status: '相机没有画面（全黑），再按一次' });
        this.startPreview();
        return;
      }

      const mime = (photo && photo.mimeType) || 'image/jpeg';
      const shot = { data: photo.data, mimeType: mime, info, usedMode };
      if (!Array.isArray(this.shots)) this.shots = [];
      if (this.captureMode === 'append' && this.shots.length < 3) {
        this.shots.push(shot);
      } else if (this.captureMode === 'replace' && this.shots.length > 0) {
        this.shots[this.shots.length - 1] = shot;
      } else {
        this.shots = [shot];
      }
      this.captureMode = 'new';
      const latest = this.shots[this.shots.length - 1];
      const preview = await this.makeConfirmImage(latest.data, latest.mimeType);
      const count = this.shots.length;
      console.log('[v8] confirm', count, latest.usedMode, latest.info.width + 'x' + latest.info.height, preview ? 'preview-ok' : 'no-preview');
      this.setData({
        phase: 'confirm',
        busy: false,
        photoSrc: preview,
        shotCount: count,
        confirmFocus: 0,
        status: '已拍 ' + count + ' 张（最新 ' + latest.usedMode + ' ' + latest.info.width + '×' + latest.info.height + ' 亮度 ' + latest.info.luma + '）',
        hint: '上下滑动选择，单击确认；题目没拍全就再拍一张',
        diag: '',
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error('[v7] error', message);
      this.setData({ busy: false, status: '出错：' + message });
      this.startCamera();
      this.setData({ status: '出错：' + message });
    }
  },

  // 生成一张缩略图给确认页：只用于让用户核对取景，不参与上传。
  async makeConfirmImage(data, mimeType) {
    try {
      const blob = new Blob([data], { type: mimeType || 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      const width = 480;
      const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width));
      const canvas = new Canvas(width, height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const buffer = await out.arrayBuffer();
      if (typeof wx === 'undefined' || typeof wx.arrayBufferToBase64 !== 'function') return '';
      return 'data:image/jpeg;base64,' + wx.arrayBufferToBase64(buffer);
    } catch (error) {
      console.log('[v7] confirm image failed', error && error.message ? error.message : String(error));
      return '';
    }
  },

  async confirmUpload() {
    if (this.data.busy) return;
    const shots = this.shots || [];
    if (shots.length === 0) { this.setData({ status: '没有待提交的照片，重拍一张' }); return; }
    this.setData({ busy: true, phase: 'busy', photoSrc: '', status: '已提交，主机正在思考…（复杂题最多约 10 分钟）' });
    try {
      const composite = await this.composeShots(shots);
      if (!composite) throw new Error('照片合成失败');
      const mime = composite.mimeType || 'image/jpeg';
      const label = shots.length > 1 ? '拼接 ' + shots.length + ' 张' : composite.usedMode;
      const info = composite.info || { width: 0, height: 0 };
      console.log('[v8] upload', mime, composite.data ? composite.data.byteLength : 0, label);
      this.waitSeconds = 0;
      if (this.waitTimer) clearInterval(this.waitTimer);
      this.waitTimer = setInterval(() => {
        this.waitSeconds += 10;
        this.setData({ status: '主机还在思考，已等 ' + this.waitSeconds + ' 秒…（可以继续等）' });
      }, 10000);
      const response = await fetch(BRIDGE_URL + '?q=' + encodeURIComponent(QUESTION), {
        method: 'POST',
        headers: {
          'content-type': mime,
          authorization: 'Bearer ' + BRIDGE_AK,
        },
        body: composite.data,
        timeout: 600000,
      });
      if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }

      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body && body.error ? String(body.error) : '';
        } catch (_) {}
        throw new Error('HTTP ' + response.status + (detail ? ' ' + detail : ''));
      }

      const data = await response.json();
      console.log('[v8] answer', response.status, String(data.answer || '').length + 'chars');
      this.shots = [];
      this.answerScrollTop = 0;
      this.setData({
        phase: 'answer',
        busy: false,
        status: '来源：' + label + ' ' + info.width + '×' + info.height,
        hint: '上下滑动翻页；单击镜腿再拍一张',
        answer: data.answer || '(空)',
        scrollTop: 0,
        photoSrc: '',
      });
    } catch (error) {
      if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
      const message = error && error.message ? error.message : String(error);
      console.error('[v8] upload error', message);
      this.setData({ busy: false, status: '出错：' + message });
      this.startCamera();
      this.setData({ status: '出错：' + message });
    }
  },

  // 多张照片按顺序竖向拼接成一张，交给现有的单图 /ask-raw。
  async composeShots(shots) {
    if (!shots || shots.length === 0) return null;
    if (shots.length === 1) {
      return { data: shots[0].data, mimeType: shots[0].mimeType, info: shots[0].info, usedMode: shots[0].usedMode };
    }
    try {
      const bitmaps = [];
      for (const shot of shots) {
        bitmaps.push(await createImageBitmap(new Blob([shot.data], { type: shot.mimeType || 'image/jpeg' })));
      }
      const width = 1080;
      const heights = bitmaps.map((item) => Math.max(1, Math.round((item.height / item.width) * width)));
      const total = heights.reduce((a, b) => a + b, 0);
      const canvas = new Canvas(width, total);
      const context = canvas.getContext('2d');
      let y = 0;
      for (let i = 0; i < bitmaps.length; i += 1) {
        context.drawImage(bitmaps[i], 0, y, width, heights[i]);
        y += heights[i];
        bitmaps[i].close();
      }
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const data = await out.arrayBuffer();
      console.log('[v8] composed', shots.length, width + 'x' + total, data.byteLength + 'B');
      return { data, mimeType: 'image/jpeg', info: { width, height: total }, usedMode: '拼接' + shots.length + '张' };
    } catch (error) {
      console.log('[v8] compose failed', error && error.message ? error.message : String(error));
      return null;
    }
  },

  addShot() {
    if (this.data.busy) return;
    if ((this.shots || []).length >= 3) { this.setData({ status: '最多 3 张，先提交或重拍' }); return; }
    this.captureMode = 'append';
    this.startCamera(true);
  },

  retake() {
    if (this.data.busy) return;
    if (this.data.phase === 'confirm' && (this.shots || []).length > 0) {
      this.captureMode = 'replace';
      this.startCamera(true);
      return;
    }
    this.captureMode = 'new';
    this.shots = [];
    this.startCamera();
  },
};
</script>

<page>
  <view class="page">
    <video
      ink:if="{{phase === 'aim' && previewSrc}}"
      class="preview"
      src="{{previewSrc}}"
      autoplay="true"
      muted="true"
      loop="false"
      object-fit="contain"
      bindplaying="onPreviewPlaying"
    ></video>

    <image
      ink:if="{{phase === 'confirm' && photoSrc}}"
      class="shot-img"
      src="{{photoSrc}}"
      mode="aspectFit"
    ></image>

    <view class="confirm-fallback" ink:if="{{phase === 'confirm' && !photoSrc}}">
      <text class="hint">已拍照。确认题目完整、数据范围都在画面里，再提交；看不到照片也可以重拍。</text>
    </view>

    <view class="statusbar" ink:if="{{status}}">
      <text class="status">{{status}}</text>
      <text class="diag" ink:if="{{diag}}">{{diag}}</text>
    </view>

    <scroll-view ink:if="{{phase === 'answer'}}" class="answer-box" scroll-y="true" scroll-top="{{scrollTop}}" bindscroll="onAnswerScroll">
      <text class="answer">{{answer}}</text>
    </scroll-view>

    <view class="footer" ink:if="{{phase === 'aim'}}">
      <text class="hint">{{hint}}</text>
    </view>

    <view class="footer" ink:if="{{phase === 'confirm'}}">
      <text class="hint">{{hint}}</text>
    </view>

    <button ink:if="{{phase === 'aim'}}" class="shoot" bindtap="onShootTap">拍摄</button>
    <view class="confirm-actions" ink:if="{{phase === 'confirm'}}">
      <button class="shoot {{confirmFocus === 0 ? 'focused' : ''}}" bindtap="confirmUpload">提交 {{shotCount}} 张</button>
      <button class="shoot secondary {{confirmFocus === 1 ? 'focused' : ''}}" bindtap="addShot">再拍一张</button>
      <button class="shoot secondary {{confirmFocus === 2 ? 'focused' : ''}}" bindtap="retake">重拍</button>
    </view>
    <button ink:if="{{phase === 'answer'}}" class="shoot" bindtap="onShootTap">再拍一张</button>
  </view>
</page>

<style>
  .page {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background-color: #000000;
  }

  .preview {
    width: 100%;
    height: 46%;
    background-color: #000000;
  }

  .shot-img {
    width: 100%;
    height: 52%;
    background-color: #000000;
  }

  .confirm-fallback {
    flex: 1;
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .statusbar {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background-color: #001800;
  }

  .status {
    font-size: 18px;
    color: #7CFF7C;
  }

  .diag {
    font-size: 13px;
    color: #4E9A4E;
  }

  .answer-box {
    width: 100%;
    flex: 1;
    padding: 10px 12px;
    box-sizing: border-box;
  }

  .answer {
    font-size: 17px;
    line-height: 26px;
    color: #E8FFE8;
    white-space: pre-wrap;
  }

  .footer {
    padding: 6px 12px;
    border-top: 1px solid #1E4A1E;
  }

  .hint {
    font-size: 15px;
    color: #8CD88C;
  }

  .shoot {
    margin: 6px 12px 10px 12px;
    height: 40px;
    font-size: 17px;
    color: #001800;
    background-color: #7CFF7C;
  }

  .secondary {
    margin-top: 0;
    color: #7CFF7C;
    background-color: #001800;
    border: 1px solid #1E4A1E;
  }

  .confirm-actions {
    display: flex;
    flex-direction: row;
    gap: 8px;
    padding: 0 12px 10px 12px;
  }

  .confirm-actions .shoot {
    flex: 1;
    margin: 0;
    height: 40px;
    padding: 0;
    font-size: 15px;
  }

  .focused {
    border: 2px solid #E8FFE8;
  }
</style>