import { cn } from "cn"
import { type ShaderDefinition, ShaderSurface } from "./ShaderSurface"

const fragmentShader = `#version 300 es
precision highp float;
uniform vec2 size;
uniform float time;
uniform float presence;
uniform vec3 tint;
out vec4 color;

const float bayer[16] = float[16](
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float weight = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    sum += weight * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    weight *= 0.5;
  }
  return sum;
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 p = cell / size.y;
  float t = time * 0.05;

  vec2 flow = vec2(fbm(p * vec2(1.4, 0.7) + vec2(t, 0.0)), fbm(p * vec2(1.4, 0.7) + vec2(5.2, -t)));
  float curtain = fbm(vec2(p.x * 3.5 + 1.6 * flow.x + t, p.y * 0.9 - t * 0.4));

  vec2 content = vec2(0.5 * size.x / size.y, 0.56);
  float apart = length((p - content) / vec2(0.7, 0.32)) + 0.6 * (flow.y - 0.5);
  float calm = 0.85 + 1.8 * (1.0 - presence);
  float reach = smoothstep(calm, calm + 0.9, apart);
  float level = clamp((curtain - 0.28) * 3.0 * reach * mix(0.75, 1.0, p.y), 0.0, 1.0) * 4.0;

  ivec2 b = ivec2(mod(cell, 4.0));
  float tone = floor(level + (bayer[b.y * 4 + b.x] + 0.5) / 16.0);

  if (tone < 1.0) discard;
  float alpha = 0.08 + 0.04 * tone;
  color = vec4(tint * alpha, alpha);
}`

const cellSize = 6

const entranceSeconds = 1.6

const swatch = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext(
  "2d",
  { willReadFrequently: true },
)

const rgbOf = (cssColor: string) => {
  if (swatch === null) return new Float32Array([1, 1, 1])

  swatch.fillStyle = cssColor
  swatch.fillRect(0, 0, 1, 1)

  return Float32Array.from(swatch.getImageData(0, 0, 1, 1).data.subarray(0, 3), (v) => v / 255)
}

const easeOut = (progress: number) => 1 - (1 - Math.min(progress, 1)) ** 3

const glow: ShaderDefinition = {
  canvasClassName:
    "block [image-rendering:pixelated] [mask-image:radial-gradient(circle_closest-side,#000_50%,transparent_65%)] [mask-size:var(--cell)_var(--cell)]",
  fragmentShader,
  framesPerSecond: 15,
  stillSeconds: entranceSeconds,
  setup: ({ canvas, gl, uniform, paint }, host) => {
    const size = uniform("size")
    const time = uniform("time")
    const presence = uniform("presence")
    const tint = uniform("tint")

    return {
      resize: ({ deviceWidth, deviceHeight, pixelRatio }) => {
        const cell = Math.max(1, Math.round(cellSize * pixelRatio))
        canvas.width = Math.ceil(deviceWidth / cell)
        canvas.height = Math.ceil(deviceHeight / cell)
        canvas.style.width = `${(canvas.width * cell) / pixelRatio}px`
        canvas.style.height = `${(canvas.height * cell) / pixelRatio}px`
        canvas.style.setProperty("--cell", `${cell / pixelRatio}px`)
        gl.uniform2f(size, canvas.width, canvas.height)
      },
      restyle: () => gl.uniform3fv(tint, rgbOf(getComputedStyle(host).color)),
      draw: (seconds) => {
        gl.uniform1f(time, seconds)
        gl.uniform1f(presence, easeOut(seconds / entranceSeconds))
        paint()
      },
    }
  },
}

export function DitherGlow(props: { className?: string }) {
  return (
    <ShaderSurface
      definition={glow}
      className={cn("overflow-hidden text-foreground", props.className)}
    />
  )
}
