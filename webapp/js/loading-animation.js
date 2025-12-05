/**
 * Flickering Grid Loading Animation
 * Creates a grid of characters from multiple IBM Plex Sans font families
 * Characters appear randomly and flicker around the center logo
 * Each character is rendered in its appropriate font family (Regular weight only)
 */

(function () {
    // Animation configuration
    const CONFIG = {
        gridSpacing: 40, // Space between grid points
        fontSize: 18, // Base font size
        sizeVariation: 0.5, // Size variation (30%)
        initialFlickerDelay: 20, // Delay between initial flickers (ms)
        flickerChance: 0.002, // Chance per frame for a star to flicker again
        disappearChance: 0.0015, // Chance per frame for a star to disappear
        reappearChance: 0.003, // Chance per frame for a disappeared star to reappear
        readyNormalTime: 0, // Time READY label stays normal before blinking (ms)
        readyBlinkTime: 1000, // Time for READY label to blink (ms)
        starsFadeTime: 1000, // Time for stars to fade out (ms)
        pauseBeforeFinalFade: 300, // Pause after stars disappear before final fade (ms)
        finalFadeTime: 1500, // Time for final fade out (ms)
        minDistanceFromCenter: 300 // Minimum distance from center for stars
    };

    // Script-specific character sets for different writing systems
    // Each script uses representative characters from its Unicode range
    const SCRIPTS = {
        latin: {
            fontFamily: 'IBM Plex Sans',
            chars:
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ' +
                'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω' + // Greek
                'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя' // Cyrillic
        },
        arabic: {
            fontFamily: 'IBM Plex Sans Arabic',
            chars: 'ابتثجحخدذرزسشصضطظعغفقكلمنهويءآأؤإئةى٠١٢٣٤٥٦٧٨٩'
        },
        devanagari: {
            fontFamily: 'IBM Plex Sans Devanagari',
            chars: 'अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह०१२३४५६७८९'
        },
        hebrew: {
            fontFamily: 'IBM Plex Sans Hebrew',
            chars: 'אבגדהוזחטיכלמנסעפצקרשתךםןףץ'
        },
        thai: {
            fontFamily: 'IBM Plex Sans Thai',
            chars: 'กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮะาิีึืุู๐๑๒๓๔๕๖๗๘๙'
        },
        korean: {
            fontFamily: 'IBM Plex Sans KR',
            chars: 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ가나다라마바사아자차카타파하각난달람밤박삭악작착칵탁팍학'
        },
        japanese: {
            fontFamily: 'IBM Plex Sans JP',
            chars: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン一二三四五六七八九十'
        }
    };

    // Combine all characters from all scripts
    const ALL_CHARACTERS = Object.values(SCRIPTS)
        .map((s) => s.chars)
        .join('');

    // Create a lookup table for quick font family retrieval by character
    const CHAR_TO_FONT = {};
    Object.entries(SCRIPTS).forEach(([scriptName, script]) => {
        for (const char of script.chars) {
            CHAR_TO_FONT[char] = script.fontFamily;
        }
    });

    // Cubic bezier easing function
    function cubicBezierEase(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    class Star {
        constructor(x, y) {
            this.x = x;
            this.y = y;

            // Random character from all scripts
            this.char = ALL_CHARACTERS.charAt(
                Math.floor(Math.random() * ALL_CHARACTERS.length)
            );

            // Get the appropriate font family for this character
            this.fontFamily = CHAR_TO_FONT[this.char] || 'IBM Plex Sans';

            // Size variation
            this.size =
                CONFIG.fontSize *
                (1 + (Math.random() - 0.5) * CONFIG.sizeVariation);

            // Initial state
            this.opacity = 0;
            this.targetOpacity = 0;
            this.hasAppeared = false;
            this.appearTime = 0;
            this.disappearTime = null;
            this.hasDisappeared = false;
            this.isCyclicallyDisappeared = false; // For ongoing disappear/reappear cycles
        }

        appear(delay) {
            this.appearTime = delay;
        }

        disappear(delay) {
            this.disappearTime = delay;
        }

        // Cyclic disappearance during normal flickering
        cyclicDisappear() {
            this.isCyclicallyDisappeared = true;
            this.targetOpacity = 0;
        }

        // Cyclic reappearance during normal flickering
        cyclicReappear() {
            this.isCyclicallyDisappeared = false;
            this.targetOpacity = 0.4; // Darker gray
        }
        flicker() {
            // Flicker to bright white, then fade back to darker gray
            this.targetOpacity = 1.0; // Bright white
        }

        update(
            currentTime,
            isFadingOut,
            fadeProgress,
            isFadingFinal,
            isPausing
        ) {
            if (isFadingOut || isFadingFinal || isPausing) {
                // Individual disappearance - only for stars that have appeared and haven't disappeared yet
                if (
                    this.hasAppeared &&
                    !this.hasDisappeared &&
                    this.disappearTime !== null &&
                    currentTime >= this.disappearTime
                ) {
                    this.opacity = 0;
                    this.targetOpacity = 0;
                    this.hasDisappeared = true;
                }
            } else if (currentTime >= this.appearTime && !this.hasAppeared) {
                // Initial appearance
                this.hasAppeared = true;
                this.targetOpacity = 0.4; // Darker gray
                this.opacity = 0.4;
            } else if (this.hasAppeared && !this.hasDisappeared) {
                // Handle cyclic disappearance
                if (this.isCyclicallyDisappeared) {
                    // Fade out to invisible
                    const diff = this.targetOpacity - this.opacity;
                    this.opacity += diff * 0.1;

                    // Once fully faded, set opacity to 0
                    if (this.opacity < 0.01) {
                        this.opacity = 0;
                    }
                } else {
                    // Smooth transition to target opacity
                    const diff = this.targetOpacity - this.opacity;
                    this.opacity += diff * 0.1;

                    // If we're close to full brightness after a flicker, start fading back to darker gray
                    if (this.opacity > 0.9 && this.targetOpacity > 0.9) {
                        this.targetOpacity = 0.4; // Fade back to darker gray
                    }
                }
            }
        }

        draw(ctx) {
            if (this.opacity > 0.01) {
                ctx.save();
                // Use bold font when star is bright (twinkling)
                const fontWeight = this.opacity > 0.7 ? '700' : '400';
                ctx.font = `${fontWeight} ${this.size}px '${this.fontFamily}'`;

                // Get color based on theme attribute
                const isLightTheme =
                    document.documentElement.getAttribute('data-theme') ===
                    'light';
                const r = isLightTheme ? 26 : 255;
                const g = isLightTheme ? 26 : 255;
                const b = isLightTheme ? 26 : 255;

                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${this.opacity})`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(this.char, this.x, this.y);
                ctx.restore();
            }
        }
    }

    class FlickeringGridAnimation {
        constructor() {
            this.canvas = null;
            this.ctx = null;
            this.stars = [];
            this.animationId = null;
            this.startTime = 0;
            this.stopRequested = false;
            this.stopRequestTime = 0;
            this.isReadyNormal = false;
            this.readyNormalStartTime = 0;
            this.isBlinkingReady = false;
            this.blinkStartTime = 0;
            this.isFadingStars = false;
            this.starsFadeStartTime = 0;
            this.isPausingBeforeFinalFade = false;
            this.pauseStartTime = 0;
            this.isFadingFinal = false;
            this.finalFadeStartTime = 0;
        }

        init() {
            // Create canvas element
            this.canvas = document.createElement('canvas');
            this.canvas.id = 'loading-animation-canvas';
            this.ctx = this.canvas.getContext('2d');

            // Insert canvas into loading overlay
            const overlay = document.getElementById('loading-overlay');
            if (overlay) {
                overlay.insertBefore(this.canvas, overlay.firstChild);
            }

            // Set canvas size
            this.resize();

            // Create grid of stars around center
            this.createStarGrid();

            // Handle window resize
            window.addEventListener('resize', () => this.resize());

            // Start animation
            this.startTime = performance.now();
            this.animate(this.startTime);
        }

        createStarGrid() {
            // Use CSS pixel dimensions (not canvas pixel dimensions)
            const width = window.innerWidth;
            const height = window.innerHeight;
            const centerX = width / 2;
            const centerY = height / 2;

            // Calculate grid bounds
            const cols = Math.ceil(width / CONFIG.gridSpacing);
            const rows = Math.ceil(height / CONFIG.gridSpacing);

            // Create stars on grid, excluding center area
            const gridStars = [];
            for (let row = -rows / 2; row <= rows / 2; row++) {
                for (let col = -cols / 2; col <= cols / 2; col++) {
                    const x = centerX + col * CONFIG.gridSpacing;
                    const y = centerY + row * CONFIG.gridSpacing;

                    // Calculate distance from center
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const distFromCenter = Math.sqrt(dx * dx + dy * dy);

                    // Only add stars outside minimum distance from center
                    if (distFromCenter >= CONFIG.minDistanceFromCenter) {
                        gridStars.push(new Star(x, y));
                    }
                }
            }

            // Shuffle stars array for random appearance order
            for (let i = gridStars.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [gridStars[i], gridStars[j]] = [gridStars[j], gridStars[i]];
            }

            // Assign appearance times
            gridStars.forEach((star, index) => {
                star.appear(index * CONFIG.initialFlickerDelay);
            });

            this.stars = gridStars;
        }

        resize() {
            const dpr = window.devicePixelRatio || 1;
            const width = window.innerWidth;
            const height = window.innerHeight;

            // Set canvas size in CSS pixels
            this.canvas.style.width = width + 'px';
            this.canvas.style.height = height + 'px';

            // Set canvas size in actual pixels (accounting for DPR)
            this.canvas.width = width * dpr;
            this.canvas.height = height * dpr;

            // Scale the context to account for DPR
            this.ctx.scale(dpr, dpr);
        }

        animate(currentTime) {
            this.animationId = requestAnimationFrame((time) =>
                this.animate(time)
            );

            const elapsedTime = currentTime - this.startTime;

            // Handle fade states
            let fadeProgress = 0;

            if (this.isFadingFinal) {
                // Final fade of everything
                const timeSinceFinalFade =
                    currentTime - this.finalFadeStartTime;
                fadeProgress = Math.min(
                    1,
                    timeSinceFinalFade / CONFIG.finalFadeTime
                );

                // Apply fade to canvas
                const easedProgress = cubicBezierEase(fadeProgress);
                this.canvas.style.opacity = 1 - easedProgress;

                if (fadeProgress >= 1) {
                    this.stop();
                    return;
                }
                // Keep stars fully faded during final fade
                fadeProgress = 1;
            } else if (this.isPausingBeforeFinalFade) {
                // Pause after stars disappeared, before final fade
                const timeSincePause = currentTime - this.pauseStartTime;

                if (timeSincePause >= CONFIG.pauseBeforeFinalFade) {
                    // Pause complete, start final fade
                    this.isPausingBeforeFinalFade = false;
                    this.isFadingFinal = true;
                    this.finalFadeStartTime = currentTime;
                }
                // Keep stars fully disappeared
                fadeProgress = 1;
            } else if (this.isFadingStars) {
                // Stars disappearing
                const timeSinceStarsFade =
                    currentTime - this.starsFadeStartTime;
                fadeProgress = Math.min(
                    1,
                    timeSinceStarsFade / CONFIG.starsFadeTime
                );

                if (fadeProgress >= 1) {
                    // Stars fully disappeared, start pause
                    this.isFadingStars = false;
                    this.isPausingBeforeFinalFade = true;
                    this.pauseStartTime = currentTime;
                }
            } else if (this.isBlinkingReady) {
                // READY label blinking phase
                const timeSinceBlink = currentTime - this.blinkStartTime;

                // Fast blink effect (toggle every 100ms)
                const statusElement = document.getElementById('loading-status');
                if (statusElement) {
                    const blinkCycle = Math.floor((timeSinceBlink / 100) % 2);
                    statusElement.style.opacity = blinkCycle === 0 ? '1' : '0';
                }

                if (timeSinceBlink >= CONFIG.readyBlinkTime) {
                    // Blinking done, hide READY label and start star disappearance
                    if (statusElement) {
                        statusElement.style.opacity = '0';
                    }
                    this.isBlinkingReady = false;
                    this.isFadingStars = true;
                    this.starsFadeStartTime = currentTime;

                    // Assign random disappear times to all appeared stars
                    const appearedStars = this.stars.filter(
                        (star) => star.hasAppeared
                    );

                    // Shuffle appeared stars for random disappearance order
                    const shuffled = [...appearedStars];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }

                    // Assign disappear times spread across the fade duration
                    const disappearInterval =
                        CONFIG.starsFadeTime / shuffled.length;
                    shuffled.forEach((star, index) => {
                        star.disappear(currentTime + index * disappearInterval);
                    });
                }
            } else if (this.isReadyNormal) {
                // READY label normal display phase (before blinking)
                const timeSinceNormal = currentTime - this.readyNormalStartTime;

                if (timeSinceNormal >= CONFIG.readyNormalTime) {
                    // Normal time done, start blinking
                    this.isReadyNormal = false;
                    this.isBlinkingReady = true;
                    this.blinkStartTime = currentTime;
                }
            } else if (this.stopRequested && !this.isReadyNormal) {
                // Stop requested, begin READY normal display
                this.isReadyNormal = true;
                this.readyNormalStartTime = currentTime;
            }

            // Random flickering for stars that have already appeared
            if (
                !this.isReadyNormal &&
                !this.isBlinkingReady &&
                !this.isFadingStars &&
                !this.isPausingBeforeFinalFade &&
                !this.isFadingFinal
            ) {
                this.stars.forEach((star) => {
                    if (star.hasAppeared && !star.isCyclicallyDisappeared) {
                        // Random flicker
                        if (Math.random() < CONFIG.flickerChance) {
                            star.flicker();
                        }
                        // Random cyclic disappearance
                        if (Math.random() < CONFIG.disappearChance) {
                            star.cyclicDisappear();
                        }
                    } else if (
                        star.hasAppeared &&
                        star.isCyclicallyDisappeared
                    ) {
                        // Random cyclic reappearance
                        if (Math.random() < CONFIG.reappearChance) {
                            star.cyclicReappear();
                        }
                    }
                });
            }

            // Clear canvas
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            // Update and draw stars
            this.stars.forEach((star) => {
                star.update(
                    currentTime,
                    this.isFadingStars,
                    fadeProgress,
                    this.isFadingFinal,
                    this.isPausingBeforeFinalFade
                );
                star.draw(this.ctx);
            });
        }

        requestStop(onComplete) {
            this.stopRequested = true;
            this.stopRequestTime = performance.now();

            // Call callback after normal + blink + star fade + pause complete, before final fade
            if (onComplete) {
                const totalTimeBeforeFinalFade =
                    CONFIG.readyNormalTime +
                    CONFIG.readyBlinkTime +
                    CONFIG.starsFadeTime +
                    CONFIG.pauseBeforeFinalFade;
                setTimeout(() => {
                    onComplete();
                }, totalTimeBeforeFinalFade);
            }
        }

        stop() {
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
        }
    }

    // Initialize animation when DOM is ready
    let animation = null;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            animation = new FlickeringGridAnimation();
            animation.init();
        });
    } else {
        animation = new FlickeringGridAnimation();
        animation.init();
    }

    // Export for potential external control
    window.WarpSpeedAnimation = {
        requestStop: (onComplete) => {
            if (animation) animation.requestStop(onComplete);
        },
        instance: () => animation
    };

    // Utility function to update loading status
    window.updateLoadingStatus = (message, isReady = false) => {
        const statusElement = document.getElementById('loading-status');
        if (statusElement) {
            statusElement.textContent = message;
            if (isReady) {
                statusElement.classList.add('ready');
            } else {
                statusElement.classList.remove('ready');
            }
        }
    };

    // Clear initial message and show "Bootstrapping..." after 2 seconds
    const initBootstrappingMessage = () => {
        const statusElement = document.getElementById('loading-status');
        if (statusElement) {
            // Clear the initial message immediately
            statusElement.textContent = '';

            // Show "Bootstrapping..." after 2 seconds if no other message has been set
            setTimeout(() => {
                if (statusElement.textContent === '') {
                    statusElement.textContent = 'Bootstrapping...';
                }
            }, 2000);
        }
    };

    // Initialize bootstrapping message when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBootstrappingMessage);
    } else {
        initBootstrappingMessage();
    }
})();
