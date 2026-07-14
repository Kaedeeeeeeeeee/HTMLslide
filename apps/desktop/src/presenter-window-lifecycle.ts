export class PresenterAsyncOperationGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(operationId: number): boolean {
    return operationId === this.generation;
  }
}
