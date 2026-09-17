/**
 * The nose is imported as text (`with { type: "text" }`), so the bundler carries
 * the drawing into the one published script. bun-types has no entry for `.svg`.
 */
declare module "*.svg" {
  const text: string;
  export default text;
}
