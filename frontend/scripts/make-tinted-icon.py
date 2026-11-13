# 从深色图标生成 iOS 透明（tinted）图标。
# 用法：python3 make-tinted-icon.py <深色图标png> <输出tinted png>
# 做法：
#  1. 边缘检测找场景轮廓（山体平台+卡片+星星+太阳+文字），去掉背景的
#     径向光晕（那是 v0.8.13 用户说的“半圆发光光圈”）和图标外框；
#  2. 倒影 = 山体平台沿 y=700 垂直翻转，亮度 x0.55；
#  3. 亮度提亮后封顶 150（去 v0.8.13 的边缘白光）；
#  4. 整个前景轮廓高斯模糊后下移 24px、亮度 70 做投影，衬在场景背后，
#     让图形和倒影看起来浮在玻璃上、有立体感（像别的 App 的透明图标）。
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, sobel, binary_dilation, binary_fill_holes, binary_closing, label, shift

src, dst = sys.argv[1], sys.argv[2]
arr = np.array(Image.open(src).convert('L'), dtype=np.float32)

sm = gaussian_filter(arr, 2)
grad = np.hypot(sobel(sm, axis=1), sobel(sm, axis=0))
edge = grad > 12
edge[:30, :] = False; edge[-30:, :] = False
edge[:, :30] = False; edge[:, -30:] = False
edge = binary_dilation(edge, structure=np.ones((5, 5)))
filled = binary_fill_holes(edge)
lab, n = label(filled)
sizes = np.bincount(lab.ravel())
keep = np.zeros_like(filled)
for i in range(1, n + 1):
    if sizes[i] > 800:
        keep[lab == i] = True
keep = binary_closing(keep, structure=np.ones((7, 7)))
keep = binary_fill_holes(keep)
lab2, n2 = label(keep)
for i in range(1, n2 + 1):
    comp = (lab2 == i)
    if comp[0, :].any() or comp[-1, :].any() or comp[:, 0].any() or comp[:, -1].any():
        keep[comp] = False
keep = binary_fill_holes(keep)

H, W = keep.shape
yy, xx = np.mgrid[0:H, 0:W]
d_tl = np.sqrt(xx ** 2 + yy ** 2); d_tr = np.sqrt((xx - W) ** 2 + yy ** 2)
d_bl = np.sqrt(xx ** 2 + (yy - H) ** 2); d_br = np.sqrt((xx - W) ** 2 + (yy - H) ** 2)
corner = ((xx < 200) & (yy < 200) & (d_tl < 200)) | ((xx > W - 200) & (yy < 200) & (d_tr < 200)) | \
         ((xx < 200) & (yy > H - 200) & (d_bl < 200)) | ((xx > W - 200) & (yy > H - 200) & (d_br < 200))
keep = keep & (~corner)

slab = keep.copy(); slab[:400, :] = False; slab[700:, :] = False
refl = shift(np.flip(slab, axis=0).astype(float), shift=(376, 0), order=0, mode='constant') > 0.5
full = keep | refl

lum = np.clip(arr, 28, None)
base = np.minimum(255 * ((lum - 28) / 227) ** 0.45, 150)
main_mask = full.copy(); main_mask[700:, :] = False
refl_mask = full.copy(); refl_mask[:700, :] = False
tinted = np.zeros_like(base)
tinted[main_mask] = base[main_mask]
tinted[refl_mask] = base[refl_mask] * 0.55
shadow = gaussian_filter(full.astype(np.float32), sigma=20)
shadow = shift(shadow, shift=(24, 0), order=1, mode='constant') * 70
out = np.maximum(tinted, shadow * (~full))
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode='L').convert('RGB').save(dst)
print(f'tinted icon written to {dst}')
