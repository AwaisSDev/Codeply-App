import logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

def add(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    logging.info(f"add({a}, {b})")
    return a + b

def subtract(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    logging.info(f"subtract({a}, {b})")
    return a - b

def multiply(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    logging.info(f"multiply({a}, {b})")
    return a * b

def divide(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    if b == 0:
        raise ValueError("Cannot divide by zero")
    logging.info(f"divide({a}, {b})")
    return a / b

def safe_divide(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    if b == 0:
        logging.warning("Division by zero attempted")
        return None
    logging.info(f"safe_divide({a}, {b})")
    return a / b

def power(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    logging.info(f"power({a}, {b})")
    return a ** b

def modulo(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Inputs must be numeric")
    if b == 0:
        logging.warning("Modulo by zero attempted")
        return None
    logging.info(f"modulo({a}, {b})")
    return a % b

def clamp(value, min_val, max_val):
    if not isinstance(value, (int, float)):
        raise TypeError("Inputs must be numeric")
    logging.info(f"clamp({value}, {min_val}, {max_val})")
    return max(min_val, min(max_val, value))

def batch_run(pairs, operation):
    logging.info(f"batch_run: {len(pairs)} pairs with {operation.__name__}")
    results = []
    for a, b in pairs:
        try:
            results.append(operation(a, b))
        except Exception as e:
            logging.error(f"Failed on ({a}, {b}): {e}")
            results.append(None)
    return results

def print_summary(results):
    print("\n--- Results Summary ---")
    operations = ["add", "subtract", "multiply", "safe_divide", "power", "modulo"]
    for op, res in zip(operations, results):
        print(f"  {op}: {res}")
    print("-----------------------\n")

def main():
    results = []
    results.append(add(10, 5))
    results.append(subtract(10, 5))
    results.append(multiply(10, 5))
    results.append(safe_divide(10, 0))
    results.append(power(2, 8))
    results.append(modulo(10, 3))
    results.append(clamp(150, 0, 100))

    batch = batch_run([(1, 2), (3, 4), (5, 0)], safe_divide)
    print("Batch results:", batch)

    print_summary(results)

if __name__ == "__main__":
    main()