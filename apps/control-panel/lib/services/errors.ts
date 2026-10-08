/** Error esperado (validación, conflicto, estado): se enseña tal cual al operador. */
export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
