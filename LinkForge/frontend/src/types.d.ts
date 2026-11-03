declare module 'jsbarcode' {
  const JsBarcode: (element: string | SVGElement, text: string, options?: Record<string, unknown>) => SVGElement;
  export default JsBarcode;
}
