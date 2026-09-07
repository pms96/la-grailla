/**
 * Escapa texto para insertarlo de forma segura dentro de HTML (emails,
 * PDFs/HTML de entradas). Cualquier dato que venga de un usuario o comprador
 * (nombre, email, notas...) debe pasar por aquí antes de interpolarse en una
 * plantilla — si no, un nombre tipo `<script>...</script>` se ejecuta tal
 * cual en quien abra ese HTML.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
