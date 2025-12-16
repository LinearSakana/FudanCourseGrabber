# FudanCourseGrabber

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Script-green.svg)](https://tampermonkey.net/)
![Version](https://img.shields.io/badge/version-0.1-blue.svg)
![License](https://img.shields.io/badge/license-Unlicense-lightgrey.svg)

复旦本科生抢课脚本 - 基于 Tampermonkey 的简易脚本，支持并发、验证码识别、批量导入当前页等功能

## ✨ 特性

### 🔥 核心功能

- **多线程并发** - 可启动多个 Web Worker 并发实例（1-10个）
- **验证码识别** - 集成 OpenCV.js 自动识别滑块验证码
- **课程批量管理** - 支持从页面自动导入和手动管理意向课程

### 🎯 智能优化

- **实时状态更新** - 显示每门课程的抢课状态、请求速率 (RPS)
- **Captcha Lookup Tables** - 预先存储 posIndex 和 moveEndX 映射，通过查表实现快速验证

> ⚠ **注意**
>
> 出于安全考量，本仓库根目录下 /captchaRecords 不会存储完整的验证码记录，仅有一个以 imgIndex 命名，储存 posIndex 与
> moveEndX 键值对的示例文件。如需进行验证码查表，您可能要自行配置

## 🚀 快速开始

### 1. 安装 Tampermonkey

在浏览器中安装 [Tampermonkey](https://tampermonkey.net/) 扩展，并点击“添加新脚本”

### 2. 安装脚本

复制 [这里](https://raw.githubusercontent.com/LinearSakana/FudanCourseGrabber/main/course-grabber.js) 的内容到新脚本中

### 3. 配置使用

1. 打开 xk.fudan.edu.cn
2. 页面右上角将出现控制面板
3. **首次使用**：在网页上进行一次手动选课操作，脚本会自动捕获必要参数
4. **导入课程**：手动点击那些你想选却没有余量的课程
5. **开始抢课**：设置并发数（在使用验证码的情况下，不建议设置为大于 2 的数字），在教务处释放余量的前十几秒开始抢课

## 📖 使用说明

### 控制面板功能

- **StudentID**：自动从请求中捕获的学生ID
- **跳过图形验证**：启用后可绕过验证码流程（请根据实际情况确定是否需要验证码）
- **并发数调节**：控制每门课程的并行请求数量
- **RPS监控**：实时显示每秒请求数
- **课程列表**：显示所有意向课程及其抢课状态

### 验证码原理

```javascript
// 使用 OpenCV.js 进行图像处理
cv.cvtColor(bgMat, bgGray, cv.COLOR_RGBA2GRAY);
cv.Canny(bgGray, bgEdges, 250, 255);
cv.matchTemplate(bgEdges, sliderEdges, result, cv.TM_CCOEFF_NORMED);
return cv.minMaxLoc(result).maxLoc.x;
```

### 依赖

- Tampermonkey 4.0+
- OpenCV.js 4.8.0


---

> 💡 **提示**：请合理使用本工具，避免对选课系统造成过大压力。
