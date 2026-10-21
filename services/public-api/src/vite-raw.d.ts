// Tests import wrangler.jsonc as text (`?raw`, a Vite feature the Workers pool runs on).
declare module '*?raw' {
  const text: string;
  export default text;
}
