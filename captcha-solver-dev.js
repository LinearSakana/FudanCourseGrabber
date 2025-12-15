// ==UserScript==
// @name         复旦抢课助手Dev
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  简易的 Tampermonkey 脚本，用于复旦大学本科生抢课；支持并发，验证码识别，批量导入
// @author       Gemini & Deepseek & github.com/LinearSakana
// @match        *://xk.fudan.edu.cn/*
// @icon         https://id.fudan.edu.cn/ac/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      self
// @connect      docs.opencv.org
// @connect      cdn-fudan.demo.supwisdom.com
// @connect      cdnjs.cloudflare.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 全局配置 ---

    const STATE = {
        studentId: '',
        turnId: '',
        headers: {}, // 从原始请求中捕获的全局 HTTP 头
        isGrabbing: false,
        isCaptchaLoopRunning: false,

        // 统计 RPS
        reqTimestamps: [], // 存储每个请求完成的时间戳
        rps: 0,
        rpsIntervalId: null, // setInterval 的 ID
    };


    // --- UI 模块 ---
    const UI = {
        panel: null,
        createPanel() {
            if (document.getElementById('grabber-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'grabber-panel';
            panel.innerHTML = `
                <div class="grabber-header">抢课助手</div>
                <div class="grabber-body">
                    <div class="grabber-input-group">
                        <label for="student-id-input">StudentID:</label>
                        <input type="text" id="student-id-input" placeholder="自动捕获..." readonly>
                    </div>
                    <div class="grabber-input-group">
                        <input type="checkbox" id="skip-captcha-checkbox">
                        <label for="skip-captcha-checkbox">跳过图形验证</label>
                    </div>
                    <div class="grabber-slider-group">
                        <label for="concurrency-slider">并发数:</label>
                        <input type="range" id="concurrency-slider" min="1" max="10" value="5">
                        <span id="concurrency-value">5</span>
                    </div>
                    <div class="grabber-info-group">
                        <span>RPS: <span id="rps-value">0</span></span>
                    </div>
                    <h3>意向课程列表</h3>
                    <ul id="course-list"></ul>
                    <div class="grabber-sub-actions">
                        <button id="import-btn">导入页面</button>
                        <button id="reset-btn">重置上下文</button>
                        <button id="clear-btn">清空列表</button>
                    </div>
                    <div class="grabber-actions">
                        <button id="grab-btn">开始抢课</button>
                    </div>
                </div>
            `;
            document.body.appendChild(panel);
            this.panel = panel;
            this.applyStyles();
            this.makeDraggable(panel, panel.querySelector('.grabber-header'));
            this.addEventListeners();
        },
        applyStyles() {
            const styles = `
                #grabber-panel { position: fixed; top: 100px; right: 20px; width: 300px; background: #f9f9f9; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); z-index: 9999; font-family: sans-serif; font-size: 14px; }
                .grabber-header { padding: 10px; background: #4a90e2; color: white; font-weight: bold; cursor: move; border-top-left-radius: 8px; border-top-right-radius: 8px; }
                .grabber-body { padding: 15px; }
                .grabber-input-group, .grabber-slider-group, .grabber-info-group { margin-bottom: 15px; display: flex; align-items: center; }
                .grabber-input-group label, .grabber-slider-group label { margin-right: 10px; cursor: pointer; }
                #student-id-input { flex-grow: 1; padding: 5px; border: 1px solid #ccc; border-radius: 4px; background: #eee; }
                #concurrency-slider { flex-grow: 1; }
                #concurrency-value { min-width: 20px; text-align: center; font-weight: bold; }
                #rps-value { font-weight: bold; color: #007bff; margin-left: 5px; }
                h3 { margin: 10px 0; font-size: 16px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
                #course-list { list-style: none; padding: 0; margin: 0; max-height: 200px; overflow-y: auto; }
                #course-list li { display: flex; align-items: center; padding: 8px 5px; border-bottom: 1px solid #eee; }
                #course-list li:last-child { border-bottom: none; }
                .course-id { flex-grow: 1; }
                .course-status { font-weight: bold; margin-right: 10px; }
                .status-pending { color: #f39c12; }
                .status-success { color: #2ecc71; }
                .course-actions button { background: none; border: none; cursor: pointer; font-size: 16px; }
                .grabber-sub-actions { display: flex; justify-content: space-between; margin-top: 10px; margin-bottom: 15px; }
                .grabber-sub-actions button { padding: 5px 10px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: #fff; }
                .grabber-actions { margin-top: 15px; text-align: center; }
                #grab-btn { width: 100%; padding: 10px; font-size: 16px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.3s; }
                #grab-btn.grabbing { background-color: #f44336; }
                button:disabled { cursor: not-allowed; opacity: 0.6; }
            `;
            const styleSheet = document.createElement("style");
            styleSheet.type = "text/css";
            styleSheet.innerText = styles;
            document.head.appendChild(styleSheet);
        },
        makeDraggable(element, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = (e) => {
                e.preventDefault();
                pos3 = e.clientX;
                pos4 = e.clientY;
                document.onmouseup = () => {
                    document.onmouseup = null;
                    document.onmousemove = null;
                };
                document.onmousemove = (e) => {
                    e.preventDefault();
                    pos1 = pos3 - e.clientX;
                    pos2 = pos4 - e.clientY;
                    pos3 = e.clientX;
                    pos4 = e.clientY;
                    element.style.top = (element.offsetTop - pos2) + "px";
                    element.style.left = (element.offsetLeft - pos1) + "px";
                };
            };
        },
        render() {
            document.getElementById('student-id-input').value = STATE.studentId;
            document.getElementById('rps-value').textContent = STATE.rps;

            const grabBtn = document.getElementById('grab-btn');
            const resetBtn = document.getElementById('reset-btn');

            if (STATE.isGrabbing) {
                grabBtn.textContent = '停止抢课';
                grabBtn.classList.add('grabbing');
                resetBtn.disabled = true;
            } else {
                grabBtn.textContent = '开始抢课';
                grabBtn.classList.remove('grabbing');
                resetBtn.disabled = false;
            }
        },
        addEventListeners() {
            document.getElementById('grab-btn').addEventListener('click', () => {
                STATE.isGrabbing ? ExecutionEngine.stop() : ExecutionEngine.start();
            });
            document.getElementById('reset-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                STATE.studentId = '';
                STATE.turnId = '';
                STATE.headers = {};
                STATE.isCaptchaLoopRunning = false;
                this.render();
                console.log('[抢课助手] 上下文信息已重置 ');
            });
        }
    };

    // --- XHR 拦截 ---
    const XHRInterceptor = {
        init() {
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (body) {
                const url = new URL(this._url, window.location.origin);

                // 捕获手动选课操作
                if (url.pathname.includes('/api/v1/student/course-select/add-predicate')) {
                    try {
                        const payload = JSON.parse(body);
                        const lessonAssoc = payload.requestMiddleDtos[0].lessonAssoc;
                        const studentAssoc = payload.studentAssoc;
                        const turnId = payload.courseSelectTurnAssoc;
                        console.log(`[抢课助手] 捕获到 Lesson ${lessonAssoc}`);
                        if (Object.keys(STATE.headers).length === 0) {
                            STATE.headers = {...this._headers};
                            delete STATE.headers['Host'];
                            delete STATE.headers['Content-Length'];
                            console.log('[抢课助手] 全局 Headers 已捕获:', STATE.headers);
                        }
                        STATE.studentId = studentAssoc.toString();
                        STATE.turnId = turnId.toString();
                        UI.render();
                    } catch (e) {
                        console.error('[抢课助手] 解析请求 payload 失败:', e);
                    }
                }
                // 捕获页面课程列表加载操作（仅在导入模式下）
                return originalSend.apply(this, arguments);
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                this._url = url;
                this._headers = {};
                return originalOpen.apply(this, arguments);
            };
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
                this._headers[header] = value;
                return originalSetRequestHeader.apply(this, arguments);
            };
        }
    };

    // --- 验证码求解  ---
    const CaptchaSolver = {
        opencvLoaded: null,
        init() {
            // 基于 openCV 实现边缘检测匹配 cutImg 位置
            if (this.opencvLoaded) return this.opencvLoaded;
            this.opencvLoaded = new Promise((resolve, reject) => {
                if (typeof cv !== 'undefined') return resolve();
                console.log('[抢课助手] 正在加载OpenCV.js...');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://docs.opencv.org/4.8.0/opencv.js',
                    onload: (response) => {
                        const script = document.createElement('script');
                        script.innerHTML = response.responseText;
                        document.head.appendChild(script);
                        const interval = setInterval(() => {
                            if (typeof cv !== 'undefined') {
                                clearInterval(interval);
                                console.log('[抢课助手] OpenCV.js 初始化成功！');
                                resolve();
                            }
                        }, 100);
                    },
                    onerror: (err) => {
                        console.error('[抢课助手] OpenCV.js 加载失败！', err);
                        reject(err);
                    }
                });
            });
            return this.opencvLoaded;
        },
        async calculate(bgBase64, sliderBase64) {
            await this.init();
            const loadImage = (src) => new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = src;
            });
            const bgImg = await loadImage('data:image/jpeg;base64,' + bgBase64);
            const sliderImg = await loadImage('data:image/png;base64,' + sliderBase64);
            let bgMat = cv.imread(bgImg), sliderMat = cv.imread(sliderImg), bgGray = new cv.Mat(),
                sliderGray = new cv.Mat(), bgEdges = new cv.Mat(), sliderEdges = new cv.Mat(), result = new cv.Mat();
            try {
                cv.cvtColor(bgMat, bgGray, cv.COLOR_RGBA2GRAY);
                cv.cvtColor(sliderMat, sliderGray, cv.COLOR_RGBA2GRAY);
                cv.Canny(bgGray, bgEdges, 250, 255);
                cv.Canny(sliderGray, sliderEdges, 252, 255);
                // 经验值，您可自行调整
                cv.matchTemplate(bgEdges, sliderEdges, result, cv.TM_CCOEFF_NORMED);
                return cv.minMaxLoc(result).maxLoc.x;
            } finally {
                bgMat.delete();
                sliderMat.delete();
                bgGray.delete();
                sliderGray.delete();
                bgEdges.delete();
                sliderEdges.delete();
                result.delete();
            }
        }
    };

    // --- 抢课执行引擎 ---
    const ExecutionEngine = {
        // 存储imgIndex键值对
        imgIndexMap: new Map(),
        addValue(key1, key2, value) {
            if (!this.imgIndexMap.has(key1)) {
                this.imgIndexMap.set(key1, new Map());
                this.imgIndexMap.get(key1).set(key2, value);
                return;
            }
            if (!this.imgIndexMap.get(key1).has(key2)) {
                this.imgIndexMap.get(key1).set(key2, value);
            }
        },
        jsZipLoaded: null,
        initJSZip() {
            this.jsZipLoaded = new Promise((resolve, reject) => {
                if (typeof JSZip !== 'undefined') return resolve();
                console.log('[抢课助手] 正在加载 JSZip...');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
                    onload: (response) => {
                        const script = document.createElement('script');
                        script.innerHTML = response.responseText;
                        document.head.appendChild(script);
                        const interval = setInterval(() => {
                            if (typeof JSZip !== 'undefined') {
                                clearInterval(interval);
                                console.log('[抢课助手] JSZip 初始化成功！');
                                resolve();
                            }
                        }, 100);
                    },
                    onerror: (err) => {
                        console.error('[抢课助手] JSZip 加载失败！', err);
                        reject(err);
                    }
                });
            });
            return this.jsZipLoaded;
        },
        async start() {
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) {
                alert('上下文信息不完整，请先在网页上进行一次手动选课操作以自动捕获 ');
                return;
            }

            STATE.isGrabbing = true;

            UI.render();
            console.log('%c[抢课助手] 开始抢课...', 'color: green;');

            this.startCaptchaLoop();

            STATE.reqTimestamps = [];
            STATE.rpsIntervalId = setInterval(this.calculateRPS.bind(this), 1000); // 每1000ms更新一次RPS
        },
        async startCaptchaLoop() {
            if (STATE.isCaptchaLoopRunning) return;

            console.log('[抢课助手] 启动验证码循环...');
            STATE.isCaptchaLoopRunning = true;

            // 确保OpenCV已加载
            try {
                await CaptchaSolver.init();
            } catch (error) {
                console.error('[抢课助手] OpenCV加载失败，验证码循环无法启动');
                STATE.isCaptchaLoopRunning = false;
                return;
            }

            try {
                await this.initJSZip();
            } catch (error) {
                console.error('[抢课助手] JSZip 加载失败，验证码循环无法启动');
                STATE.isCaptchaLoopRunning = false;
                return;
            }

            // 启动验证码 Loop
            const captchaLoop = async () => {
                if (!STATE.isCaptchaLoopRunning) return;

                try {
                    console.log('[验证码 Loop] 开始新一轮验证码验证...');

                    const randomImgUrl = `/api/v1/student/course-select/getRandomImg?studentId=${STATE.studentId}&turnId=${STATE.turnId}`;
                    const randomImgResponse = await this.makeRequest('GET', randomImgUrl, STATE.headers);
                    const randomImgParsed = JSON.parse(randomImgResponse.responseText);
                    if (randomImgParsed.result !== 0 || !randomImgParsed.data) {
                        throw new Error(`获取随机验证码失败: ${randomImgParsed.message || '无有效数据'}`);
                    }

                    const {imgIndex, posIndex} = randomImgParsed.data;
                    console.log(`[验证码 Loop] 获取到验证码参数: imgIndex=${imgIndex}, posIndex=${posIndex}`);

                    // 跨域获取验证码图片
                    const cdnUrl = `https://cdn-fudan.demo.supwisdom.com/verify/static/verify-image/${imgIndex}/${posIndex}/verify-image.json`;
                    const cdnHeaders = {
                        ...STATE.headers,
                        'Host': 'cdn-fudan.demo.supwisdom.com',
                        'Origin': 'https://xk.fudan.edu.cn',
                        'Referer': 'https://xk.fudan.edu.cn/',
                        'Sec-Fetch-Site': 'cross-site'
                    };

                    const cdnResponse = await this.makeRequest('GET', cdnUrl, cdnHeaders);
                    const imgParsed = JSON.parse(JSON.parse(cdnResponse.responseText).data);

                    const moveEndX = await CaptchaSolver.calculate(imgParsed.SrcImage, imgParsed.CutImage);
                    console.log(`[验证码 Loop] 滑块距离: ${moveEndX}`);

                    const rstImgUrl = `/api/v1/student/course-select/rstImgSwipe?moveEndX=${moveEndX}&wbili=1&studentId=${STATE.studentId}&turnId=${STATE.turnId}`;
                    const rstResponse = await this.makeRequest('GET', rstImgUrl, STATE.headers);
                    const rstData = JSON.parse(rstResponse.responseText).data;

                    if (rstData && rstData.success) {
                        console.log('[验证码 Loop] 滑块验证成功！');
                        this.addValue(imgIndex, posIndex, moveEndX);
                        captchaLoop();
                    } else {
                        throw new Error('滑块验证失败');
                    }

                } catch (error) {
                    console.error(`[验证码 Loop] 错误: ${error.message}`);
                    // 忽略任何错误
                    captchaLoop();
                }
            };

            // 启动循环
            captchaLoop();
        },

        // 发送请求
        makeRequest(method, url, headers) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    onload: (res) => {
                        STATE.reqTimestamps.push(Date.now());
                        resolve(res);
                    },
                    onerror: (err) => {
                        STATE.reqTimestamps.push(Date.now());
                        reject(err);
                    }
                });
            });
        },

        /**
         * 临时工具函数，将 Map 打包为 ZIP 并下载
         * @param {Map<string, string[]>} dataMap - 要打包的数据
         * @param {string} zipName - ZIP 文件名（可选，默认为 'captcha.zip'）
         */
        async downloadMap(dataMap, zipName = 'captcha.zip') {
            const zip = new JSZip();

            for (const [key, innerMap] of dataMap.entries()) {
                // 将内层 Map 转换为 JSON
                const jsonContent = JSON.stringify(Object.fromEntries(innerMap), null, 2);
                // 创建 .json 文件
                zip.file(`${key}.json`, jsonContent);
            }

            const content = await zip.generateAsync({type: 'blob'});
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = zipName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        },

        async stopCaptchaLoop() {
            STATE.isCaptchaLoopRunning = false;
            console.log('[抢课助手] 验证码循环已停止');
            console.log('请下载以下验证码图片数据以供分析：');
            await this.downloadMap(this.imgIndexMap);
        },

        stop() {
            console.log('[抢课助手] 正在停止所有抢课任务...');
            STATE.isGrabbing = false;
            this.stopCaptchaLoop();

            // RPS 计数停止
            clearInterval(STATE.rpsIntervalId);
            STATE.rpsIntervalId = null;
            STATE.reqTimestamps = [];
            STATE.rps = 0;

            UI.render();
            console.log('%c[抢课助手] 所有任务已停止', 'color: red;');
        },

        calculateRPS() {
            const now = Date.now();
            STATE.reqTimestamps = STATE.reqTimestamps.filter(timestamp => (now - timestamp) < 1000);
            STATE.rps = STATE.reqTimestamps.length;
            UI.render();
        }
    };

    function init() {
        console.log('[抢课助手] 脚本已启动 ');
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                UI.createPanel();
                UI.render();
            });
        } else {
            UI.createPanel();
            UI.render();
        }
        XHRInterceptor.init();
    }

    init();

})();
