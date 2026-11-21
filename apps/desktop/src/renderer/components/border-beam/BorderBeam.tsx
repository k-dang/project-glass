import { type ShaderDefinition, ShaderSurface } from "@/ShaderSurface"
import { darkScheme } from "@/theme"

const fragmentShader = `#version 300 es
precision highp float;
uniform vec2 size;
uniform float dpr;
uniform float radius;
uniform float angle;
uniform mat3 hueRotation;
uniform mat3 saturation;
uniform vec3 ink;
uniform float highlightValue[11];
uniform vec4 shadow;
uniform float strokeOpacity;
uniform float innerOpacity;
out vec4 color;

const vec3 blobColor[9] = vec3[9](
  vec3(255, 50, 100), vec3(40, 140, 255), vec3(50, 200, 80),
  vec3(30, 185, 170), vec3(100, 70, 255), vec3(40, 140, 255),
  vec3(255, 120, 40), vec3(240, 50, 180), vec3(180, 40, 240)
);
const vec2 blobAt[9] = vec2[9](
  vec2(0.33, -0.074), vec2(0.12, -0.05), vec2(0.021, 0.683),
  vec2(0.021, 0.683), vec2(0.744, 1.0), vec2(0.55, 1.0),
  vec2(0.939, 0.0), vec2(1.0, 0.271), vec2(1.0, 0.271)
);
const vec2 strokeBlob[9] = vec2[9](
  vec2(70, 40), vec2(60, 35), vec2(40, 70), vec2(20, 35), vec2(180, 32),
  vec2(85, 26), vec2(74, 32), vec2(26, 42), vec2(52, 48)
);

const float windowAt[11] = float[11](0.0, 0.3, 0.36, 0.44, 0.52, 0.8, 0.86, 0.92, 0.95, 1.0, 1.0);
const float windowValue[11] = float[11](0.0, 0.0, 0.1, 0.35, 1.0, 1.0, 0.35, 0.1, 0.0, 0.0, 0.0);
const float highlightAt[11] = float[11](0.0, 0.54, 0.57, 0.6, 0.63, 0.66, 0.69, 0.72, 0.75, 0.78, 1.0);
const float rimWidth = 28.0;

float ramp(float t, float at[11], float value[11]) {
  for (int i = 1; i < 11; i++) {
    if (t <= at[i]) return mix(value[i - 1], value[i], (t - at[i - 1]) / max(at[i] - at[i - 1], 1e-5));
  }
  return value[10];
}

float roundedBox(vec2 p, vec2 extent, float r) {
  vec2 q = abs(p) - extent + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }

vec4 filtered(vec4 premultiplied) {
  if (premultiplied.a <= 0.0) return premultiplied;
  vec3 c = clamp(hueRotation * (premultiplied.rgb / premultiplied.a), 0.0, 1.0);
  c = clamp(saturation * clamp(c * 1.3, 0.0, 1.0), 0.0, 1.0);
  return vec4(c * premultiplied.a, premultiplied.a);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, size.y * dpr - gl_FragCoord.y) / dpr;
  vec2 fromCenter = p - size * 0.5;
  float edge = roundedBox(fromCenter, size * 0.5, radius);

  if (edge > 0.5 || min(min(p.x, size.x - p.x), min(p.y, size.y - p.y)) > rimWidth) discard;

  float turn = fract((degrees(atan(fromCenter.x, -fromCenter.y)) - angle) / 360.0);
  float window = ramp(turn, windowAt, windowValue);

  if (window <= 0.0) discard;

  vec4 stroke = vec4(0.0);
  vec4 inner = vec4(0.0);
  for (int i = 8; i >= 0; i--) {
    vec3 rgb = blobColor[i] / 255.0;
    vec2 at = blobAt[i] * size;
    float s = 1.0 - min(length((p - at) / strokeBlob[i]), 1.0);
    stroke = over(vec4(rgb * s, s), stroke);
    float n = 0.45 * (1.0 - min(length((p - at) / (strokeBlob[i] * 0.9)), 1.0));
    inner = over(vec4(rgb * n, n), inner);
  }

  float highlight = ramp(turn, highlightAt, highlightValue);
  stroke = over(vec4(ink * highlight, highlight), stroke);

  float depth = -edge - 1.0;
  float x = depth / 4.5;
  float shade = 1.0 - 0.5 * (1.0 + tanh(0.7978846 * (x + 0.044715 * x * x * x)));
  inner = over(shadow * shade, inner);

  float ring = clamp(0.5 - roundedBox(fromCenter, size * 0.5, radius - 1.0), 0.0, 1.0)
    - clamp(0.5 - roundedBox(fromCenter, size * 0.5 - 1.0, radius - 2.0), 0.0, 1.0);
  float vertical = clamp(max(1.0 - p.y / rimWidth, 1.0 - (size.y - p.y) / rimWidth), 0.0, 1.0);
  float horizontal = clamp(max(1.0 - p.x / rimWidth, 1.0 - (size.x - p.x) / rimWidth), 0.0, 1.0);
  float rim = vertical + horizontal * (1.0 - vertical);
  float inside = clamp(0.5 - edge, 0.0, 1.0);

  vec4 strokeLayer = filtered(stroke) * ring * window * strokeOpacity;
  vec4 innerLayer = filtered(inner) * window * rim * inside * innerOpacity;
  color = over(strokeLayer, innerLayer);
}`

const spinSeconds = 1.96

const hueSeconds = 12

const hueRotationOf = (degrees: number) => {
  const k = Math.cos((degrees * Math.PI) / 180)
  const s = Math.sin((degrees * Math.PI) / 180)

  return [
    0.213 + k * 0.787 - s * 0.213,
    0.715 - k * 0.715 - s * 0.715,
    0.072 - k * 0.072 + s * 0.928,
    0.213 - k * 0.213 + s * 0.143,
    0.715 + k * 0.285 + s * 0.14,
    0.072 - k * 0.072 - s * 0.283,
    0.213 - k * 0.213 - s * 0.787,
    0.715 - k * 0.715 + s * 0.715,
    0.072 + k * 0.928 + s * 0.072,
  ]
}

const saturationOf = (amount: number) => [
  0.213 + 0.787 * amount,
  0.715 - 0.715 * amount,
  0.072 - 0.072 * amount,
  0.213 - 0.213 * amount,
  0.715 + 0.285 * amount,
  0.072 - 0.072 * amount,
  0.213 - 0.213 * amount,
  0.715 - 0.715 * amount,
  0.072 + 0.928 * amount,
]

const looks = {
  dark: {
    ink: [1, 1, 1],
    highlight: [0, 0, 0.1, 0.3, 0.6, 0.75, 0.6, 0.3, 0.1, 0, 0],
    shadow: [0.27, 0.27, 0.27, 0.27],
    strokeOpacity: 0.26,
    innerOpacity: 0.42,
    saturation: saturationOf(1.2),
  },
  light: {
    ink: [0, 0, 0],
    highlight: [0, 0, 0.08, 0.2, 0.4, 0.55, 0.4, 0.2, 0.08, 0, 0],
    shadow: [0, 0, 0, 0.14],
    strokeOpacity: 0.12,
    innerOpacity: 0.26,
    saturation: saturationOf(1.5),
  },
}

const beam: ShaderDefinition = {
  canvasClassName:
    "block size-full opacity-100 transition-opacity duration-600 ease-out starting:opacity-0",
  fragmentShader,
  framesPerSecond: 30,
  stillSeconds: 0,
  setup: ({ canvas, gl, uniform, paint }, host) => {
    const size = uniform("size")
    const dpr = uniform("dpr")
    const radius = uniform("radius")
    const angle = uniform("angle")
    const hueRotation = uniform("hueRotation")
    const saturation = uniform("saturation")
    const ink = uniform("ink")
    const highlight = uniform("highlightValue")
    const shadow = uniform("shadow")
    const strokeOpacity = uniform("strokeOpacity")
    const innerOpacity = uniform("innerOpacity")

    return {
      resize: ({ width, height, deviceWidth, deviceHeight, pixelRatio }) => {
        canvas.width = deviceWidth
        canvas.height = deviceHeight
        gl.uniform2f(size, width, height)
        gl.uniform1f(dpr, pixelRatio)
      },
      restyle: () => {
        const look = darkScheme.matches ? looks.dark : looks.light
        gl.uniform1f(radius, Number.parseFloat(getComputedStyle(host).borderTopLeftRadius))
        gl.uniform3fv(ink, look.ink)
        gl.uniform1fv(highlight, look.highlight)
        gl.uniform4fv(shadow, look.shadow)
        gl.uniform1f(strokeOpacity, look.strokeOpacity)
        gl.uniform1f(innerOpacity, look.innerOpacity)
        gl.uniformMatrix3fv(saturation, true, look.saturation)
      },
      draw: (seconds) => {
        gl.uniform1f(angle, ((seconds / spinSeconds) % 1) * 360)
        gl.uniformMatrix3fv(
          hueRotation,
          true,
          hueRotationOf(-30 * Math.cos((2 * Math.PI * seconds) / hueSeconds)),
        )
        paint()
      },
    }
  },
}

export function BorderBeam() {
  return <ShaderSurface definition={beam} className="absolute -inset-px z-2 rounded-[inherit]" />
}
